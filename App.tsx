import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { DialectConfig, Message } from './types';
import { DIALECTS, AUDIO_SAMPLE_RATE_INPUT, AUDIO_SAMPLE_RATE_OUTPUT } from './constants';

// Simple list for Tools (STT/TTS/Translation)
const TOOL_LANGUAGES = [
  "Saudi Arabic", "English", "Urdu", "Hindi", 
  "Lebanese Arabic", "Egyptian Arabic", "Spanish", "French", "German"
];

interface GenAIBlob {
  data: string;
  mimeType: string;
}

// --- Audio Utils ---
function decode(base64: string) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function encode(bytes: Uint8Array) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function decodeAudioData(data: Uint8Array, ctx: AudioContext, sampleRate: number, numChannels: number): Promise<AudioBuffer> {
  const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const dataInt16 = new Int16Array(buffer);
  const frameCount = dataInt16.length / numChannels;
  const audioBuffer = ctx.createBuffer(numChannels, frameCount, sampleRate);
  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = audioBuffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return audioBuffer;
}

function createBlob(data: Float32Array): GenAIBlob {
  const l = data.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    int16[i] = Math.max(-1, Math.min(1, data[i])) * 32767;
  }
  return {
    data: encode(new Uint8Array(int16.buffer)),
    mimeType: 'audio/pcm;rate=16000',
  };
}

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'agent' | 'stt' | 'tts' | 'translate'>('agent');
  const [currentDialect, setCurrentDialect] = useState<DialectConfig>(DIALECTS[0]); 
  const [isConnected, setIsConnected] = useState(false);
  const [status, setStatus] = useState<'idle' | 'listening' | 'thinking' | 'speaking'>('idle');
  const [messages, setMessages] = useState<Message[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  
  const [liveUserSpeech, setLiveUserSpeech] = useState('');
  const [liveAssistantSpeech, setLiveAssistantSpeech] = useState('');
  const [inputLevel, setInputLevel] = useState(0);

  // --- Tools State ---
  
  // STT State
  const [sttLanguage, setSttLanguage] = useState('English');
  const [sttTranscript, setSttTranscript] = useState('');
  const [sttLoading, setSttLoading] = useState(false);
  const [sttRecording, setSttRecording] = useState(false);
  const [sttAudioUrl, setSttAudioUrl] = useState<string | null>(null);
  const [sttBlob, setSttBlob] = useState<Blob | null>(null);

  // TTS State
  const [ttsLanguage, setTtsLanguage] = useState('English');
  const [ttsInput, setTtsInput] = useState('');
  const [ttsLoading, setTtsLoading] = useState(false);

  // Translation State
  const [translateSource, setTranslateSource] = useState('English');
  const [translateTarget, setTranslateTarget] = useState('Saudi Arabic');
  const [translateInput, setTranslateInput] = useState('');
  const [translateResult, setTranslateResult] = useState('');
  const [translateLoading, setTranslateLoading] = useState(false);

  // Refs
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const sessionRef = useRef<any>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const currentInputTranscription = useRef('');
  const currentOutputTranscription = useRef('');
  const transcriptScrollRef = useRef<HTMLDivElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    if (transcriptScrollRef.current) {
      transcriptScrollRef.current.scrollTop = transcriptScrollRef.current.scrollHeight;
    }
  }, [messages, liveUserSpeech, liveAssistantSpeech]);

  const stopSession = useCallback(() => {
    if (sessionRef.current) {
      try { sessionRef.current.close(); } catch(e) {}
      sessionRef.current = null;
    }
    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.disconnect();
      scriptProcessorRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }
    if (inputAudioContextRef.current) {
      inputAudioContextRef.current.close();
      inputAudioContextRef.current = null;
    }
    if (outputAudioContextRef.current) {
      outputAudioContextRef.current.close();
      outputAudioContextRef.current = null;
    }
    sourcesRef.current.forEach(source => { try { source.stop(); } catch(e) {} });
    sourcesRef.current.clear();
    setIsConnected(false);
    setStatus('idle');
    setInputLevel(0);
    setLiveAssistantSpeech('');
    setLiveUserSpeech('');
    currentInputTranscription.current = '';
    currentOutputTranscription.current = '';
  }, []);

  const startSession = useCallback(async (dialect: DialectConfig) => {
    setErrorMsg(null);
    setStatus('thinking');
    setMessages([]);
    try {
      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: AUDIO_SAMPLE_RATE_INPUT });
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: AUDIO_SAMPLE_RATE_OUTPUT });
      await inputCtx.resume();
      await outputCtx.resume();
      inputAudioContextRef.current = inputCtx;
      outputAudioContextRef.current = outputCtx;

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } } },
          systemInstruction: { parts: [{ text: dialect.systemPrompt }] },
          // This tells the model to pay attention to speech patterns
          inputAudioTranscription: { model: "google-search" }, 
        },
        callbacks: {
          onopen: () => {
            setIsConnected(true);
            setStatus('listening');
            nextStartTimeRef.current = 0;
            
            sessionPromise.then(session => {
              // *** FIX: STRICTLY FORCE LANGUAGE CONTEXT ON CONNECT ***
              // This ensures the model knows how to transcribe the USER'S input immediately
              session?.sendRealtimeInput({ 
                text: `SETUP: The user is speaking in ${dialect.label}. 
                IMPERATIVE: Transcribe the user's speech using the correct ${dialect.label} script. 
                Do not translate the transcription. Keep it in the original language.` 
              });
            });

            const source = inputCtx.createMediaStreamSource(stream);
            const scriptProcessor = inputCtx.createScriptProcessor(2048, 1, 1);
            scriptProcessorRef.current = scriptProcessor;

            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              let sum = 0;
              for(let i=0; i<inputData.length; i++) sum += inputData[i] * inputData[i];
              const rms = Math.sqrt(sum / inputData.length);
              setInputLevel(Math.min(100, rms * 500));
              const pcmBlob = createBlob(inputData);
              sessionPromise.then(session => session?.sendRealtimeInput({ media: pcmBlob }));
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.serverContent?.inputTranscription) {
              currentInputTranscription.current += message.serverContent.inputTranscription.text;
              setLiveUserSpeech(currentInputTranscription.current);
            }
            if (message.serverContent?.outputTranscription) {
              currentOutputTranscription.current += message.serverContent.outputTranscription.text;
              setLiveAssistantSpeech(currentOutputTranscription.current);
            }
            if (message.serverContent?.turnComplete) {
              const u = currentInputTranscription.current.trim();
              const a = currentOutputTranscription.current.trim();
              if (u || a) {
                setMessages(prev => [...prev, 
                  ...(u ? [{ role: 'user' as const, text: u, timestamp: Date.now() }] : []),
                  ...(a ? [{ role: 'assistant' as const, text: a, timestamp: Date.now() }] : [])
                ]);
              }
              currentInputTranscription.current = '';
              currentOutputTranscription.current = '';
              setLiveAssistantSpeech('');
              setLiveUserSpeech('');
              setStatus('listening');
            }
            const modelTurn = message.serverContent?.modelTurn;
            if (modelTurn?.parts) {
              for (const part of modelTurn.parts) {
                if (part.inlineData?.data) {
                  setStatus('speaking');
                  const audioBuffer = await decodeAudioData(decode(part.inlineData.data), outputCtx, AUDIO_SAMPLE_RATE_OUTPUT, 1);
                  const source = outputCtx.createBufferSource();
                  source.buffer = audioBuffer;
                  source.connect(outputCtx.destination);
                  source.onended = () => {
                    sourcesRef.current.delete(source);
                    if (sourcesRef.current.size === 0) setStatus('listening');
                  };
                  const startTime = Math.max(nextStartTimeRef.current, outputCtx.currentTime);
                  source.start(startTime);
                  nextStartTimeRef.current = startTime + audioBuffer.duration;
                  sourcesRef.current.add(source);
                }
              }
            }
          },
          onerror: (e) => { setErrorMsg("An error occurred. Connection reset."); stopSession(); },
          onclose: () => { setIsConnected(false); setStatus('idle'); }
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err: any) { setErrorMsg("Microphone access denied or connection failed."); stopSession(); }
  }, [stopSession]);

  const toggleConnection = () => isConnected ? stopSession() : startSession(currentDialect);

  const handleDialectChange = (dialectId: string) => {
    const dialect = DIALECTS.find(d => d.id === dialectId);
    if (dialect) {
      setCurrentDialect(dialect);
      if (isConnected) {
        stopSession();
        startSession(dialect);
      }
    }
  };

  // --- Utility Handlers ---
  const toggleSttRecording = async () => {
    if (sttRecording) {
      mediaRecorderRef.current?.stop();
      setSttRecording(false);
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const recorder = new MediaRecorder(stream);
        audioChunksRef.current = [];
        recorder.ondataavailable = (e) => audioChunksRef.current.push(e.data);
        recorder.onstop = async () => {
          const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
          setSttAudioUrl(URL.createObjectURL(blob));
          setSttBlob(blob); // Save blob for manual transcription
          setSttTranscript(""); // Clear previous
        };
        mediaRecorderRef.current = recorder;
        recorder.start();
        setSttRecording(true);
      } catch (err) {
        setErrorMsg("Could not start recording.");
      }
    }
  };

  const handleManualTranscribe = async () => {
    if (!sttBlob) return;
    setSttLoading(true);
    try {
      const reader = new FileReader();
      reader.onloadend = async () => {
        const base64 = (reader.result as string).split(',')[1];
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
        const response = await ai.models.generateContent({
          model: 'gemini-2.0-flash-exp', // Using a robust model for transcription
          contents: [
            { text: `Transcribe this audio. The language spoken is ${sttLanguage}. Output strictly the transcription in the ${sttLanguage} script.` },
            { inlineData: { data: base64, mimeType: 'audio/webm' } }
          ]
        });
        setSttTranscript(response.response.text() || "No speech detected.");
      };
      reader.readAsDataURL(sttBlob);
    } catch (e) {
      setSttTranscript("Transcription failed.");
    } finally {
      setSttLoading(false);
    }
  };

  const handleTts = async () => {
    if (!ttsInput.trim()) return;
    setTtsLoading(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      // Generate speech via Gemini (Text -> Audio)
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: `Please say the following text in ${ttsLanguage}: ${ttsInput}` }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } }
        }
      });
      const part = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
      if (part?.inlineData?.data) {
        const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
        const buffer = await decodeAudioData(decode(part.inlineData.data), audioCtx, 24000, 1);
        const source = audioCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(audioCtx.destination);
        source.start();
      }
    } catch (e) {
      console.error(e);
    } finally {
      setTtsLoading(false);
    }
  };

  const handleTranslate = async () => {
    if (!translateInput.trim()) return;
    setTranslateLoading(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      const response = await ai.models.generateContent({
        model: 'gemini-2.0-flash-exp',
        contents: `Act as a professional translator. Translate the following text from ${translateSource} to ${translateTarget}. Only provide the translated text.
        
        Text: "${translateInput}"`
      });
      setTranslateResult(response.response.text() || "Translation error.");
    } catch (e) {
      setTranslateResult("Failed to translate.");
    } finally {
      setTranslateLoading(false);
    }
  };

  return (
    <div className="page-wrapper">
      <nav className="navbar">
        <div className="nav-container">
          <div className="logo">
            <span className="logo-icon">🇸🇦</span>
            <span className="logo-text">Saudi Voice Intelligence</span>
          </div>
          <div className="nav-links">
            <a href="#agent" onClick={() => setActiveTab('agent')}>Talk to Agent</a>
            <a href="#tools" onClick={() => setActiveTab('stt')}>Try AI Tools</a>
          </div>
        </div>
      </nav>

      <section className="hero">
        <div className="hero-bg-pattern"></div>
        <div className="hero-content">
          <span className="hero-badge">AI SPEECH PLATFORM</span>
          <h1 className="hero-title">
            <span className="gradient-text">AI Voice Agent</span>
          </h1>
          <p className="hero-subtitle">Unified support for Telecom billing and Hospital services across 10 regional dialects.</p>
          <div className="hero-buttons">
            <button onClick={() => setActiveTab('agent')} className="btn btn-accent btn-large">Talk to Agent</button>
            <button onClick={() => setActiveTab('stt')} className="btn btn-outline btn-large">Try AI Tools</button>
          </div>
        </div>
      </section>

      <div className="tool-tabs" id="tools" style={{padding: '1rem', background: '#f8fafc', borderTop: '1px solid #e2e8f0', display: 'flex', justifyContent: 'center', gap: '0.5rem'}}>
        {(['agent', 'stt', 'tts', 'translate'] as const).map(tab => (
          <button 
            key={tab} 
            className={`tab-btn ${activeTab === tab ? 'active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === 'agent' ? 'AI AGENT' : tab.toUpperCase()}
          </button>
        ))}
      </div>

      {activeTab === 'agent' && (
        <section className="agent-section" id="agent">
          <div className="agent-container">
            {errorMsg && <div style={{background: '#fee2e2', color: '#ef4444', padding: '1rem', borderRadius: '12px', marginBottom: '1.5rem', fontWeight: 600, textAlign: 'center'}}>{errorMsg}</div>}
            
            <div className="agent-card">
              <div className="agent-header">
                <div className="agent-avatar">🤖</div>
                <div className="agent-info">
                  <h3 style={{fontSize: '1.2rem'}}>{currentDialect.label} Agent</h3>
                  <p style={{fontSize: '0.85rem', color: '#64748b'}}>Current Status: <span style={{fontWeight: 700, color: status === 'speaking' ? 'var(--accent-dark)' : 'inherit'}}>{status.toUpperCase()}</span></p>
                </div>
                <div className="status-pill">
                  <span className={`status-dot ${isConnected ? 'connected' : ''} ${status === 'speaking' ? 'speaking' : ''}`}></span>
                </div>
              </div>

              <div className="agent-controls">
                <div className="language-select-tool">
                  <label>SWITCH SESSION DIALECT</label>
                  <select 
                    value={currentDialect.id} 
                    onChange={(e) => handleDialectChange(e.target.value)}
                  >
                    {DIALECTS.map(d => <option key={d.id} value={d.id}>{d.flag} {d.label}</option>)}
                  </select>
                </div>
                
                <div className="agent-buttons">
                  <button onClick={toggleConnection} className={`btn btn-full btn-large ${isConnected ? 'btn-secondary' : 'btn-accent'}`}>
                    {isConnected ? 'Disconnect Session' : 'Talk to Agent'}
                  </button>
                </div>

                {isConnected && (
                  <div style={{marginTop: '1.5rem'}}>
                    <div style={{display: 'flex', justifyContent: 'space-between', marginBottom: '6px'}}>
                      <span style={{fontSize: '0.75rem', color: '#64748b', fontWeight: 700}}>AUDIO SENSITIVITY</span>
                      <span style={{fontSize: '0.75rem', color: '#64748b'}}>{Math.round(inputLevel)}%</span>
                    </div>
                    <div style={{width: '100%', height: '8px', background: '#e2e8f0', borderRadius: '10px', overflow: 'hidden'}}>
                      <div style={{width: `${inputLevel}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.1s'}}></div>
                    </div>
                  </div>
                )}
              </div>

              <div ref={transcriptScrollRef} className="conversation-area" style={{background: '#fff', padding: '1.5rem', minHeight: '380px'}}>
                {messages.length === 0 && !liveUserSpeech && !liveAssistantSpeech && (
                  <div style={{textAlign: 'center', padding: '5rem 2rem', color: '#94a3b8'}}>
                    <div style={{fontSize: '3rem', marginBottom: '1.5rem'}}>📞</div>
                    <p>Select a language and click "Talk to Agent" to begin.</p>
                  </div>
                )}
                {messages.map((msg, idx) => (
                  <div key={idx} className={`message ${msg.role}`}>
                    <p style={{fontSize: '0.7rem', fontWeight: 800, textTransform: 'uppercase', marginBottom: '6px', opacity: 0.6}}>{msg.role === 'user' ? 'You' : 'Agent'}</p>
                    <p style={{fontSize: '1rem', lineHeight: '1.5'}}>{msg.text}</p>
                  </div>
                ))}
                {liveUserSpeech && (
                  <div className="message user" style={{opacity: 0.75, border: '1px dashed #000'}}>
                    <p style={{fontSize: '0.7rem', fontWeight: 800, marginBottom: '4px'}}>Listening...</p>
                    <p style={{fontStyle: 'italic'}}>{liveUserSpeech}</p>
                  </div>
                )}
                {liveAssistantSpeech && (
                  <div className="message assistant" style={{borderColor: 'var(--accent)', background: '#f7fee7'}}>
                    <p style={{fontSize: '0.7rem', fontWeight: 800, marginBottom: '4px'}}>Agent Speaking...</p>
                    <p><b>{liveAssistantSpeech}</b></p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>
      )}

      {activeTab === 'stt' && (
        <section className="tools-section">
          <div className="tool-panel active" style={{maxWidth: '1200px'}}>
            <div className="section-header">
              <span className="section-badge">STT ENGINE</span>
              <h2>Speech-to-Text Lab</h2>
              <p>Record audio and get accurate transcripts in your selected language.</p>
            </div>
            
            <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem'}}>
              {/* Left Column: Recording Controls */}
              <div className="audio-upload-zone" style={{background: '#fff', border: '1px solid #e2e8f0', borderRadius: '16px', padding: '2rem', display: 'flex', flexDirection: 'column', gap: '1.5rem'}}>
                
                <div className="language-select-tool">
                  <label>1. SELECT LANGUAGE</label>
                  <select value={sttLanguage} onChange={(e) => setSttLanguage(e.target.value)}>
                    {TOOL_LANGUAGES.map(l => <option key={l} value={l}>{l}</option>)}
                  </select>
                </div>

                <div style={{textAlign: 'center', padding: '2rem 0', borderTop: '1px dashed #e2e8f0', borderBottom: '1px dashed #e2e8f0'}}>
                  <div style={{fontSize: '3rem', marginBottom: '1rem', transition: 'all 0.3s'}}>{sttRecording ? '🔴' : '🎤'}</div>
                  <button onClick={toggleSttRecording} className={`btn btn-large btn-full ${sttRecording ? 'btn-secondary' : 'btn-primary'}`}>
                    {sttRecording ? 'Stop Recording' : '2. Start Recording'}
                  </button>
                  {sttAudioUrl && (
                     <div style={{marginTop: '1.5rem'}}>
                        <audio src={sttAudioUrl} controls style={{width: '100%'}} />
                     </div>
                  )}
                </div>

                <button 
                  onClick={handleManualTranscribe} 
                  disabled={!sttAudioUrl || sttLoading || sttRecording}
                  className="btn btn-accent btn-large btn-full"
                >
                  {sttLoading ? 'Transcribing...' : '3. Transcribe Audio'}
                </button>
              </div>

              {/* Right Column: Transcript Result */}
              <div className="transcript-box" style={{background: '#f8fafc', height: '100%', minHeight: '400px', display: 'flex', flexDirection: 'column'}}>
                <h4 style={{fontSize: '0.75rem', fontWeight: 800, textTransform: 'uppercase', color: '#94a3b8', marginBottom: '12px'}}>Transcription Result</h4>
                <div style={{fontSize: '1.1rem', flex: 1, whiteSpace: 'pre-wrap'}}>
                  {sttLoading ? (
                    <div style={{display: 'flex', alignItems: 'center', gap: '10px', color: '#666'}}>
                      <span className="status-dot speaking"></span> Generating transcript in {sttLanguage}...
                    </div>
                  ) : sttTranscript || <span style={{color: '#cbd5e1'}}>Transcript will appear here after you click "Transcribe Audio"...</span>}
                </div>
              </div>
            </div>
          </div>
        </section>
      )}

      {activeTab === 'tts' && (
        <section className="tools-section">
          <div className="tool-panel active">
            <div className="section-header">
              <span className="section-badge">TTS ENGINE</span>
              <h2>Voice Synthesis Hub</h2>
              <p>Convert text to human-like voice.</p>
            </div>
            
            <div className="language-select-tool">
              <label>SELECT LANGUAGE TO SPEAK</label>
              <select value={ttsLanguage} onChange={(e) => setTtsLanguage(e.target.value)}>
                 {TOOL_LANGUAGES.map(l => <option key={l} value={l}>{l}</option>)}
              </select>
            </div>

            <textarea 
              className="transcript-box" 
              style={{width: '100%', minHeight: '200px', resize: 'none', background: '#fff', padding: '1.5rem', fontSize: '1.1rem'}}
              placeholder={`Enter text in ${ttsLanguage} here...`}
              value={ttsInput}
              onChange={(e) => setTtsInput(e.target.value)}
            />
            <button onClick={handleTts} disabled={ttsLoading || !ttsInput.trim()} className="btn btn-accent btn-full btn-large" style={{marginTop: '2rem'}}>
              {ttsLoading ? 'Generating Audio...' : 'Generate Speech'}
            </button>
          </div>
        </section>
      )}

      {activeTab === 'translate' && (
        <section className="tools-section">
          <div className="tool-panel active">
            <div className="section-header">
              <span className="section-badge">TRANSLATION</span>
              <h2>Enterprise Translator</h2>
              <p>Professional AI Translation.</p>
            </div>
            <div className="tool-grid">
              <div style={{display: 'flex', flexDirection: 'column', gap: '1.5rem'}}>
                
                {/* Source and Target Selectors */}
                <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem'}}>
                    <div className="language-select-tool">
                        <label>FROM</label>
                        <select value={translateSource} onChange={(e) => setTranslateSource(e.target.value)}>
                            {TOOL_LANGUAGES.map(l => <option key={l} value={l}>{l}</option>)}
                        </select>
                    </div>
                    <div className="language-select-tool">
                        <label>TO</label>
                        <select value={translateTarget} onChange={(e) => setTranslateTarget(e.target.value)}>
                            {TOOL_LANGUAGES.map(l => <option key={l} value={l}>{l}</option>)}
                        </select>
                    </div>
                </div>

                <textarea 
                  className="transcript-box" 
                  style={{width: '100%', minHeight: '220px', resize: 'none', background: '#fff', padding: '1rem', fontSize: '1rem'}}
                  placeholder={`Type ${translateSource} text here...`}
                  value={translateInput}
                  onChange={(e) => setTranslateInput(e.target.value)}
                />
                
                <button onClick={handleTranslate} disabled={translateLoading || !translateInput.trim()} className="btn btn-accent btn-full btn-large">
                  {translateLoading ? 'Translating...' : 'Translate Now'}
                </button>
              </div>
              <div className="transcript-box" style={{background: '#f1f5f9', minHeight: '220px'}}>
                <h4 style={{fontSize: '0.75rem', fontWeight: 800, textTransform: 'uppercase', color: '#94a3b8', marginBottom: '12px'}}>
                    Translated to {translateTarget}
                </h4>
                <div style={{fontSize: '1.1rem', color: '#1e293b'}}>
                  {translateResult || 'The result will appear here.'}
                </div>
              </div>
            </div>
          </div>
        </section>
      )}

      <footer className="footer">
        <div className="logo" style={{justifyContent: 'center', marginBottom: '2rem'}}>
          <span className="logo-icon">🇸🇦</span>
          <span className="logo-text">Saudi Voice Intelligence</span>
        </div>
        <p style={{color: '#94a3b8', fontSize: '0.95rem'}}>© 2025 SVI Global. Precision AI Speech Solutions for MENA.</p>
      </footer>
    </div>
  );
};

export default App;