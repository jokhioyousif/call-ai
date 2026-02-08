
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Type, GenerateContentResponse } from '@google/genai';
import { Language, DialectConfig, Message } from './types';
import { DIALECTS, AUDIO_SAMPLE_RATE_INPUT, AUDIO_SAMPLE_RATE_OUTPUT } from './constants';

interface GenAIBlob {
  data: string;
  mimeType: string;
}

// --- Utils ---
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
  const [translateTarget, setTranslateTarget] = useState('Arabic');
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
  const audioChunksRef = useRef<BlobPart[]>([]);

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
            // Send a small nudge text to start greeting immediately
            sessionPromise.then(session => session?.sendRealtimeInput({ text: "Please start the conversation with your greeting." }));

            const source = inputCtx.createMediaStreamSource(stream);
            const scriptProcessor = inputCtx.createScriptProcessor(2048, 1, 1);
            scriptProcessorRef.current = scriptProcessor;

            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              let sum = 0;
              for(let i=0; i<inputData.length; i++) sum += inputData[i] * inputData[i];
              const rms = Math.sqrt(sum / inputData.length);
              setInputLevel(Math.min(100, rms * 600));
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
    } catch (err: any) { setErrorMsg(err.message || "Access denied."); stopSession(); }
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

  // --- Tool Handlers ---
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
            { text: "Transcribe the following audio accurately. Just provide the text." },
            { inlineData: { data: base64, mimeType: blob.type } }
          ]
        });
        setSttTranscript(response.text || "No speech detected.");
      };
      reader.readAsDataURL(blob);
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
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: ttsInput }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } }
        }
      });
      const base64 = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData?.data;
      if (base64) {
        const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
        const buffer = await decodeAudioData(decode(base64), audioCtx, 24000, 1);
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
        contents: `Translate the following text to ${translateTarget}: "${translateInput}"`
      });
      setTranslateResult(response.text || "Translation error.");
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
            <span className="logo-icon">🎙️</span>
            <span className="logo-text">Saudi Voice Intelligence</span>
          </div>
          <div className="nav-links">
            <a href="#agent" onClick={() => setActiveTab('agent')}>Live Agent</a>
            <a href="#tools" onClick={() => setActiveTab('stt')}>AI Tools</a>
          </div>
        </div>
      </nav>

      <section className="hero">
        <div className="hero-bg-pattern"></div>
        <div className="hero-content">
          <span className="hero-badge">INTELLECTUAL AI</span>
          <h1 className="hero-title">
            Voice Agent<br />Specialist<br />
            <span className="gradient-text">Arabic Dialects</span>
          </h1>
          <p className="hero-subtitle">High-speed Real-time Telecommunication Assistant with multi-language support.</p>
        </div>
      </section>

      <div className="tool-tabs" id="tools" style={{padding: '1rem', background: '#f8fafc', display: 'flex', justifyContent: 'center', gap: '0.5rem'}}>
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
        <section className="agent-section">
          <div className="agent-container">
            {errorMsg && <div style={{background: '#fee2e2', color: '#ef4444', padding: '1rem', borderRadius: '8px', marginBottom: '1rem'}}>{errorMsg}</div>}
            <div className="agent-card">
              <div className="agent-header">
                <div className="agent-avatar">🤖</div>
                <div className="agent-info">
                  <h3>{currentDialect.label} Assistant</h3>
                  <p>Status: <b style={{color: status === 'speaking' ? 'var(--accent-dark)' : 'inherit'}}>{status.toUpperCase()}</b></p>
                </div>
                <div className="status-pill">
                  <span className={`status-dot ${isConnected ? 'connected' : ''} ${status === 'speaking' ? 'speaking' : ''}`}></span>
                </div>
              </div>

              <div className="agent-controls">
                <div className="language-select-tool">
                  <label>SELECT CONVERSATION LANGUAGE:</label>
                  <select 
                    value={currentDialect.id} 
                    onChange={(e) => handleDialectChange(e.target.value)}
                  >
                    {DIALECTS.map(d => <option key={d.id} value={d.id}>{d.flag} {d.label}</option>)}
                  </select>
                </div>
                <button onClick={toggleConnection} className={`btn btn-full btn-large ${isConnected ? 'btn-secondary' : 'btn-accent'}`}>
                  {isConnected ? 'End Conversation' : 'Start Calling'}
                </button>
                {isConnected && (
                  <div style={{marginTop: '1.5rem'}}>
                    <p style={{fontSize: '0.65rem', color: '#64748b', fontWeight: 600}}>MIC LEVEL</p>
                    <div style={{width: '100%', height: '6px', background: '#e2e8f0', borderRadius: '10px', marginTop: '4px', overflow: 'hidden'}}>
                      <div style={{width: `${inputLevel}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.1s'}}></div>
                    </div>
                  </div>
                )}
              </div>

              <div ref={transcriptScrollRef} className="conversation-area" style={{background: '#fcfcfc', borderTop: '1px solid #e2e8f0'}}>
                {messages.length === 0 && !liveUserSpeech && !liveAssistantSpeech && (
                  <div style={{textAlign: 'center', padding: '3rem', color: '#94a3b8'}}>
                    <p>Select your language and click "Start Calling" to begin.</p>
                  </div>
                )}
                {messages.map((msg, idx) => (
                  <div key={idx} className={`message ${msg.role}`}>
                    <p style={{fontSize: '0.6rem', opacity: 0.5, marginBottom: '2px', fontWeight: 700}}>{msg.role === 'user' ? 'YOU' : 'AGENT'}</p>
                    <p>{msg.text}</p>
                  </div>
                ))}
                {liveUserSpeech && (
                  <div className="message user" style={{opacity: 0.6}}>
                    <p style={{fontSize: '0.6rem', fontWeight: 700}}>YOU (TRANSCRIBING...)</p>
                    <p><i>{liveUserSpeech}</i></p>
                  </div>
                )}
                {liveAssistantSpeech && (
                  <div className="message assistant">
                    <p style={{fontSize: '0.6rem', fontWeight: 700}}>AGENT (SPEAKING...)</p>
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
              <span className="section-badge">AUDIO TO TEXT</span>
              <h2>Speech Recognition</h2>
              <p>Record audio to get a high-accuracy transcript in any language.</p>
            </div>
            <div className="audio-upload-zone" style={{background: '#f8fafc'}}>
              <button onClick={toggleSttRecording} className={`btn btn-large ${sttRecording ? 'btn-secondary' : 'btn-accent'}`}>
                {sttRecording ? 'Stop Recording' : 'Start Recording'}
              </button>
              {sttAudioUrl && <audio src={sttAudioUrl} controls style={{marginTop: '1.5rem', width: '100%'}} />}
            </div>
            <div className="transcript-box" style={{marginTop: '1.5rem'}}>
              {sttLoading ? 'Analyzing audio...' : sttTranscript || 'Transcript will appear here...'}
            </div>
          </div>
        </section>
      )}

      {activeTab === 'tts' && (
        <section className="tools-section">
          <div className="tool-panel active">
            <div className="section-header">
              <span className="section-badge">TEXT TO AUDIO</span>
              <h2>Voice Synthesis</h2>
              <p>Turn any text into natural, high-quality human speech.</p>
            </div>
            <textarea 
              className="transcript-box" 
              style={{width: '100%', minHeight: '150px', resize: 'none', background: '#fff', padding: '1.5rem'}}
              placeholder="Enter text to convert to voice..."
              value={ttsInput}
              onChange={(e) => setTtsInput(e.target.value)}
            />
            <button onClick={handleTts} disabled={ttsLoading} className="btn btn-accent btn-full btn-large" style={{marginTop: '1.5rem'}}>
              {ttsLoading ? 'Synthesizing...' : 'Play Voice'}
            </button>
          </div>
        </section>
      )}

      {activeTab === 'translate' && (
        <section className="tools-section">
          <div className="tool-panel active">
            <div className="section-header">
              <span className="section-badge">MULTILINGUAL</span>
              <h2>Instant Translation</h2>
              <p>Translate content between languages with context awareness.</p>
            </div>
            <div className="tool-grid">
              <div style={{display: 'flex', flexDirection: 'column', gap: '1rem'}}>
                <textarea 
                  className="transcript-box" 
                  style={{width: '100%', minHeight: '150px', resize: 'none', background: '#fff', padding: '1rem'}}
                  placeholder="Paste text to translate..."
                  value={translateInput}
                  onChange={(e) => setTranslateInput(e.target.value)}
                />
                <select 
                  className="transcript-box" 
                  style={{padding: '0.8rem', minHeight: 'auto'}}
                  value={translateTarget}
                  onChange={(e) => setTranslateTarget(e.target.value)}
                >
                  <option value="English">To English</option>
                  <option value="Arabic">To Arabic</option>
                  <option value="Urdu">To Urdu</option>
                  <option value="Hindi">To Hindi</option>
                </select>
                <button onClick={handleTranslate} disabled={translateLoading} className="btn btn-accent btn-full">
                  {translateLoading ? 'Translating...' : 'Translate Now'}
                </button>
              </div>
              <div className="transcript-box" style={{background: '#f1f5f9'}}>
                {translateResult || 'Translation result will appear here...'}
              </div>
            </div>
          </div>
        </section>
      )}

      <footer className="footer">
        <p>© 2025 Saudi Voice Intelligence. Dedicated AI for Telecommunications.</p>
      </footer>
    </div>
  );
};

export default App;
