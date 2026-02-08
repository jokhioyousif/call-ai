
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Type, GenerateContentResponse } from '@google/genai';
import { Language, DialectConfig, Message } from './types';
import { DIALECTS, AUDIO_SAMPLE_RATE_INPUT, AUDIO_SAMPLE_RATE_OUTPUT } from './constants';

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

  // Tools State
  const [sttTranscript, setSttTranscript] = useState('');
  const [sttLoading, setSttLoading] = useState(false);
  const [sttRecording, setSttRecording] = useState(false);
  const [sttAudioUrl, setSttAudioUrl] = useState<string | null>(null);

  const [ttsInput, setTtsInput] = useState('');
  const [ttsLoading, setTtsLoading] = useState(false);

  const [translateInput, setTranslateInput] = useState('');
  const [translateTarget, setTranslateTarget] = useState('Saudi Arabic');
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

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } } },
          systemInstruction: dialect.systemPrompt,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setIsConnected(true);
            setStatus('listening');
            nextStartTimeRef.current = 0;
            
            sessionPromise.then(session => {
              // Send nudge in native dialect to anchor the model's language early
              session?.sendRealtimeInput({ text: `Please greet me in ${dialect.label} dialect and wait for my response.` });
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
          onerror: (e) => { setErrorMsg("Session error. Resetting..."); stopSession(); },
          onclose: () => { setIsConnected(false); setStatus('idle'); }
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err: any) { setErrorMsg("Access denied."); stopSession(); }
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

  // --- STT/TTS Handlers ---
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
          processStt(blob);
        };
        mediaRecorderRef.current = recorder;
        recorder.start();
        setSttRecording(true);
      } catch (err) {
        setErrorMsg("Mic error.");
      }
    }
  };

  const processStt = async (blob: Blob) => {
    setSttLoading(true);
    try {
      const reader = new FileReader();
      reader.onloadend = async () => {
        const base64 = (reader.result as string).split(',')[1];
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        const response = await ai.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: [
            { text: "Transcribe audio strictly in its original script. No translation." },
            { inlineData: { data: base64, mimeType: 'audio/webm' } }
          ]
        });
        setSttTranscript(response.text || "No speech.");
      };
      reader.readAsDataURL(blob);
    } catch (e) {
      setSttTranscript("Failed.");
    } finally {
      setSttLoading(false);
    }
  };

  const handleTts = async () => {
    if (!ttsInput.trim()) return;
    setTtsLoading(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: ttsInput }] }],
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
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Translate to ${translateTarget}: "${translateInput}"`
      });
      setTranslateResult(response.text || "Error.");
    } catch (e) {
      setTranslateResult("Failed.");
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
            <a href="#agent" onClick={() => setActiveTab('agent')}>Agent</a>
            <a href="#tools" onClick={() => setActiveTab('stt')}>Utilities</a>
          </div>
        </div>
      </nav>

      <section className="hero">
        <div className="hero-bg-pattern"></div>
        <div className="hero-content">
          <span className="hero-badge">AI SPEECH PLATFORM</span>
          <h1 className="hero-title">
            Enterprise<br />Voice AI<br />
            <span className="gradient-text">Dialect Expert</span>
          </h1>
          <p className="hero-subtitle">Specialized support for Telecom and Hospital services across multiple regional dialects.</p>
          <div className="hero-buttons">
            <button onClick={() => setActiveTab('agent')} className="btn btn-accent btn-large">Launch Agent</button>
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
            {tab.toUpperCase()}
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
                  <h3 style={{fontSize: '1.2rem'}}>{currentDialect.label} Support</h3>
                  <p style={{fontSize: '0.85rem', color: '#64748b'}}>Status: <span style={{fontWeight: 700, color: status === 'speaking' ? 'var(--accent-dark)' : 'inherit'}}>{status.toUpperCase()}</span></p>
                </div>
                <div className="status-pill">
                  <span className={`status-dot ${isConnected ? 'connected' : ''} ${status === 'speaking' ? 'speaking' : ''}`}></span>
                </div>
              </div>

              <div className="agent-controls">
                <div className="language-select-tool">
                  <label>CURRENT AGENT DIALECT</label>
                  <select 
                    value={currentDialect.id} 
                    onChange={(e) => handleDialectChange(e.target.value)}
                  >
                    {DIALECTS.map(d => <option key={d.id} value={d.id}>{d.flag} {d.label}</option>)}
                  </select>
                </div>
                
                <div className="agent-buttons">
                  <button onClick={toggleConnection} className={`btn btn-full btn-large ${isConnected ? 'btn-secondary' : 'btn-accent'}`}>
                    {isConnected ? 'End Call' : 'Start Agent'}
                  </button>
                </div>

                {isConnected && (
                  <div style={{marginTop: '1.5rem'}}>
                    <div style={{display: 'flex', justifyContent: 'space-between', marginBottom: '6px'}}>
                      <span style={{fontSize: '0.75rem', color: '#64748b', fontWeight: 700}}>SPEECH LEVEL</span>
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
                    <p>Select your language and establish a connection to speak with our AI agent.</p>
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
                    <p style={{fontSize: '0.7rem', fontWeight: 800, marginBottom: '4px'}}>Hearing...</p>
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
          <div className="tool-panel active">
            <div className="section-header">
              <span className="section-badge">STT ENGINE</span>
              <h2>Speech-to-Text Analysis</h2>
              <p>Highly accurate transcription for regional Arabic dialects.</p>
            </div>
            <div className="audio-upload-zone" style={{background: '#f8fafc', border: '2px dashed #cbd5e1', padding: '3rem'}}>
              <div style={{fontSize: '3rem', marginBottom: '1.5rem'}}>{sttRecording ? '🔴' : '🎤'}</div>
              <button onClick={toggleSttRecording} className={`btn btn-large ${sttRecording ? 'btn-secondary' : 'btn-accent'}`}>
                {sttRecording ? 'Stop Recording' : 'Start Recording'}
              </button>
              {sttAudioUrl && <div style={{marginTop: '2rem'}}><audio src={sttAudioUrl} controls style={{width: '100%'}} /></div>}
            </div>
            <div className="transcript-box" style={{marginTop: '2rem', background: '#fff'}}>
              <h4 style={{fontSize: '0.75rem', fontWeight: 800, textTransform: 'uppercase', color: '#94a3b8', marginBottom: '12px'}}>Result</h4>
              <div style={{fontSize: '1.1rem'}}>
                {sttLoading ? <span className="loading-dots">Processing...</span> : sttTranscript || 'Transcript will appear here.'}
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
              <h2>Voice Synthesis</h2>
              <p>Convert any text into natural sounding audio responses.</p>
            </div>
            <textarea 
              className="transcript-box" 
              style={{width: '100%', minHeight: '200px', resize: 'none', background: '#fff', padding: '1.5rem', fontSize: '1.1rem'}}
              placeholder="Enter text to hear it spoken..."
              value={ttsInput}
              onChange={(e) => setTtsInput(e.target.value)}
            />
            <button onClick={handleTts} disabled={ttsLoading || !ttsInput.trim()} className="btn btn-accent btn-full btn-large" style={{marginTop: '2rem'}}>
              {ttsLoading ? 'Synthesizing...' : 'Generate Voice'}
            </button>
          </div>
        </section>
      )}

      {activeTab === 'translate' && (
        <section className="tools-section">
          <div className="tool-panel active">
            <div className="section-header">
              <span className="section-badge">TRANSLATION</span>
              <h2>AI Translator</h2>
              <p>Communicate across Borders with instant dialect-aware translation.</p>
            </div>
            <div className="tool-grid">
              <div style={{display: 'flex', flexDirection: 'column', gap: '1.5rem'}}>
                <textarea 
                  className="transcript-box" 
                  style={{width: '100%', minHeight: '220px', resize: 'none', background: '#fff', padding: '1rem', fontSize: '1rem'}}
                  placeholder="Text to translate..."
                  value={translateInput}
                  onChange={(e) => setTranslateInput(e.target.value)}
                />
                <select 
                  className="transcript-box" 
                  style={{padding: '1rem', minHeight: 'auto'}}
                  value={translateTarget}
                  onChange={(e) => setTranslateTarget(e.target.value)}
                >
                  <option value="Saudi Arabic">To Saudi Arabic</option>
                  <option value="English">To English</option>
                  <option value="Urdu">To Urdu</option>
                  <option value="Hindi">To Hindi</option>
                </select>
                <button onClick={handleTranslate} disabled={translateLoading || !translateInput.trim()} className="btn btn-accent btn-full btn-large">
                  {translateLoading ? 'Translating...' : 'Translate'}
                </button>
              </div>
              <div className="transcript-box" style={{background: '#f1f5f9', minHeight: '220px'}}>
                <h4 style={{fontSize: '0.75rem', fontWeight: 800, textTransform: 'uppercase', color: '#94a3b8', marginBottom: '12px'}}>Result</h4>
                <div style={{fontSize: '1.1rem', color: '#1e293b'}}>
                  {translateResult || 'Result will be shown here.'}
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
        <p style={{color: '#94a3b8', fontSize: '0.95rem'}}>© 2025 SVI Global. Specialized AI Voice Solutions.</p>
      </footer>
    </div>
  );
};

export default App;
