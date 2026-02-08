
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
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);
  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
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
  const [activeTab, setActiveTab] = useState<'stt' | 'tts' | 'translate' | 'agent'>('agent');
  const [currentDialect, setCurrentDialect] = useState<DialectConfig>(DIALECTS[0]); 
  const [isConnected, setIsConnected] = useState(false);
  const [status, setStatus] = useState<'idle' | 'listening' | 'thinking' | 'speaking'>('idle');
  const [messages, setMessages] = useState<Message[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  
  const [liveUserSpeech, setLiveUserSpeech] = useState('');
  const [liveAssistantSpeech, setLiveAssistantSpeech] = useState('');

  // Tool specific state
  const [sttTranscript, setSttTranscript] = useState('');
  const [sttLoading, setSttLoading] = useState(false);
  const [sttRecording, setSttRecording] = useState(false);
  const [sttAudioBase64, setSttAudioBase64] = useState<string | null>(null);

  const [ttsInput, setTtsInput] = useState('');
  const [ttsLoading, setTtsLoading] = useState(false);
  const [ttsAudioStatus, setTtsAudioStatus] = useState<string | null>(null);

  const [translateInput, setTranslateInput] = useState('');
  const [translateTarget, setTranslateTarget] = useState('ar');
  const [translateResult, setTranslateResult] = useState('');
  const [translateLoading, setTranslateLoading] = useState(false);

  // Refs
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const sessionRef = useRef<any>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);
  
  const currentInputTranscription = useRef('');
  const currentOutputTranscription = useRef('');
  const transcriptScrollRef = useRef<HTMLDivElement>(null);
  const logCounter = useRef(0);

  useEffect(() => {
    console.log("[DEBUG] API Key Check:", process.env.API_KEY ? "EXISTS" : "MISSING");
    if (transcriptScrollRef.current) {
      transcriptScrollRef.current.scrollTop = transcriptScrollRef.current.scrollHeight;
    }
  }, [messages, liveUserSpeech, liveAssistantSpeech]);

  const stopSession = useCallback(() => {
    console.log("[DEBUG] Stopping session...");
    if (sessionRef.current) {
      try { sessionRef.current.close(); } catch(e) {}
      sessionRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }
    if (inputAudioContextRef.current) {
      try { inputAudioContextRef.current.close(); } catch(e) {}
      inputAudioContextRef.current = null;
    }
    if (outputAudioContextRef.current) {
      try { outputAudioContextRef.current.close(); } catch(e) {}
      outputAudioContextRef.current = null;
    }
    sourcesRef.current.forEach(source => { try { source.stop(); } catch(e) {} });
    sourcesRef.current.clear();
    setIsConnected(false);
    setStatus('idle');
    setLiveAssistantSpeech('');
    setLiveUserSpeech('');
  }, []);

  const startSession = useCallback(async (dialect: DialectConfig) => {
    console.log("[DEBUG] Attempting to start session for:", dialect.label);
    setErrorMsg(null);
    setStatus('thinking');

    if (!process.env.API_KEY) {
      const err = "API Key is missing. Ensure the API_KEY environment variable is set on Railway.";
      console.error("[DEBUG]", err);
      setErrorMsg(err);
      setStatus('idle');
      return;
    }

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("Your browser does not support microphone access.");
      }

      console.log("[DEBUG] Initializing AudioContexts...");
      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: AUDIO_SAMPLE_RATE_INPUT });
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: AUDIO_SAMPLE_RATE_OUTPUT });
      inputAudioContextRef.current = inputCtx;
      outputAudioContextRef.current = outputCtx;

      console.log("[DEBUG] Requesting Microphone access...");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      console.log("[DEBUG] Microphone access granted.");

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      console.log("[DEBUG] Connecting to Live API...");
      
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
            console.log("[DEBUG] Connection established (onopen)");
            setIsConnected(true);
            setStatus('listening');
            nextStartTimeRef.current = 0;
            
            console.log("[DEBUG] Starting audio capture and streaming...");
            const source = inputCtx.createMediaStreamSource(stream);
            const scriptProcessor = inputCtx.createScriptProcessor(2048, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              
              // Only log a fraction of chunks to avoid flooding the console
              logCounter.current++;
              if (logCounter.current % 100 === 0) {
                console.log("[DEBUG] Sending audio chunk count:", logCounter.current);
              }

              sessionPromise.then((session) => {
                if (session) session.sendRealtimeInput({ media: pcmBlob });
              }).catch(err => {
                console.error("[DEBUG] Failed to send realtime input:", err);
              });
            };
            
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            console.log("[DEBUG] Received message from model:", message);
            
            if (message.serverContent?.outputTranscription) {
              currentOutputTranscription.current += message.serverContent.outputTranscription.text;
              setLiveAssistantSpeech(currentOutputTranscription.current);
            } else if (message.serverContent?.inputTranscription) {
              currentInputTranscription.current += message.serverContent.inputTranscription.text;
              setLiveUserSpeech(currentInputTranscription.current);
            }

            if (message.serverContent?.turnComplete) {
              console.log("[DEBUG] Turn complete. Final User Text:", currentInputTranscription.current);
              console.log("[DEBUG] Turn complete. Final Assistant Text:", currentOutputTranscription.current);
              
              const userText = currentInputTranscription.current.trim();
              const assistantText = currentOutputTranscription.current.trim();
              
              if (userText || assistantText) {
                setMessages(prev => [
                  ...prev,
                  ...(userText ? [{ role: 'user' as const, text: userText, timestamp: Date.now() }] : []),
                  ...(assistantText ? [{ role: 'assistant' as const, text: assistantText, timestamp: Date.now() }] : [])
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
                  console.log("[DEBUG] Model provided audio chunk. Playing...");
                  setStatus('speaking');
                  const base64Audio = part.inlineData.data;
                  nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputCtx.currentTime);
                  const audioData = decode(base64Audio);
                  const audioBuffer = await decodeAudioData(audioData, outputCtx, AUDIO_SAMPLE_RATE_OUTPUT, 1);
                  const source = outputCtx.createBufferSource();
                  source.buffer = audioBuffer;
                  source.connect(outputCtx.destination);
                  source.onended = () => {
                    sourcesRef.current.delete(source);
                    if (sourcesRef.current.size === 0) {
                       console.log("[DEBUG] Audio playback finished.");
                       setStatus('listening');
                    }
                  };
                  source.start(nextStartTimeRef.current);
                  nextStartTimeRef.current += audioBuffer.duration;
                  sourcesRef.current.add(source);
                }
              }
            }

            if (message.serverContent?.interrupted) {
              console.log("[DEBUG] Conversation interrupted by user.");
              sourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              setLiveAssistantSpeech('');
              setStatus('listening');
            }
          },
          onerror: (e) => { 
            console.error('[DEBUG] Session connection error:', e); 
            setErrorMsg("Connection error. Ensure your API key is valid and you are online.");
            stopSession(); 
          },
          onclose: (e) => { 
            console.log("[DEBUG] Session connection closed:", e);
            setIsConnected(false); 
            setStatus('idle'); 
          }
        }
      });
      sessionRef.current = await sessionPromise;
      console.log("[DEBUG] sessionRef assigned.");
    } catch (err: any) {
      console.error('[DEBUG] Global startSession error:', err);
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setErrorMsg("Microphone access denied. Please grant permission in your browser.");
      } else {
        setErrorMsg(err.message || "Failed to start conversation.");
      }
      setStatus('idle');
      stopSession();
    }
  }, [stopSession]);

  const toggleConnection = () => {
    if (isConnected) stopSession();
    else startSession(currentDialect);
  };

  const handleDialectChange = (lang: Language) => {
    const dialect = DIALECTS.find(d => d.id === lang) || DIALECTS[0];
    setCurrentDialect(dialect);
    if (isConnected) {
      stopSession();
      startSession(dialect);
    }
  };

  // --- Tool Handlers ---
  const handleSttRecord = async () => {
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
          const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
          const reader = new FileReader();
          reader.readAsDataURL(audioBlob);
          reader.onloadend = () => {
            const base64 = (reader.result as string).split(',')[1];
            setSttAudioBase64(base64);
          };
          stream.getTracks().forEach(t => t.stop());
        };
        recorder.start();
        mediaRecorderRef.current = recorder;
        setSttRecording(true);
      } catch (err) {
        console.error("[DEBUG] STT Recording error:", err);
        alert("Microphone access failed.");
      }
    }
  };

  const handleTranscribe = async () => {
    if (!sttAudioBase64) return;
    setSttLoading(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: {
          parts: [
            { inlineData: { mimeType: 'audio/webm', data: sttAudioBase64 } },
            { text: `Transcribe this audio strictly. Language: ${currentDialect.label}. Output only the transcript.` }
          ]
        }
      });
      setSttTranscript(response.text || "No transcription found.");
    } catch (err) {
      console.error("[DEBUG] Transcription error:", err);
      setSttTranscript("Transcription error.");
    } finally {
      setSttLoading(false);
    }
  };

  const handleTtsGenerate = async () => {
    if (!ttsInput.trim()) return;
    setTtsLoading(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: `Speak this text as ${currentDialect.label}: ${ttsInput}` }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
        },
      });
      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (base64Audio) {
        const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
        const audioBuffer = await decodeAudioData(decode(base64Audio), ctx, 24000, 1);
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(ctx.destination);
        source.start();
        setTtsAudioStatus("Playing generated audio...");
      }
    } catch (err) {
      console.error("[DEBUG] TTS error:", err);
      alert("Error generating speech.");
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
        contents: `Translate to ${translateTarget === 'ar' ? 'Arabic' : translateTarget === 'ur' ? 'Urdu' : translateTarget === 'hi' ? 'Hindi' : 'English'}: "${translateInput}"`
      });
      setTranslateResult(response.text || "Translation error.");
    } catch (err) {
      console.error("[DEBUG] Translation error:", err);
      setTranslateResult("Translation error.");
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
            <span className="logo-text">Saudi Voice Agent</span>
          </div>
          <div className="nav-links">
            <a href="#tools" onClick={() => setActiveTab('stt')}>AI Tools</a>
            <a href="#agent" onClick={() => setActiveTab('agent')}>Voice Agent</a>
          </div>
        </div>
      </nav>

      <section className="hero">
        <div className="hero-bg-pattern"></div>
        <div className="hero-content">
          <span className="hero-badge">WE BUILD</span>
          <h1 className="hero-title">
            AI Models<br />
            That Master<br />
            <span className="gradient-text">Arabic Dialects</span>
          </h1>
          <p className="hero-subtitle">For Those Who Never Compromise On Quality</p>
          <div className="hero-buttons">
            <a href="#tools" className="btn btn-primary" onClick={() => setActiveTab('stt')}>Try AI Tools</a>
            <a href="#agent" className="btn btn-secondary" onClick={() => setActiveTab('agent')}>Talk to Agent</a>
          </div>
        </div>
        <div className="hero-decoration">
          <div className="floating-circle circle-1"></div>
          <div className="floating-circle circle-2"></div>
        </div>
      </section>

      <section id="tools" className="tools-section">
        <div className="section-header">
          <span className="section-badge">Our Models</span>
          <h2>Revolutionizing Arabic dialects<br />with AI speech intelligence</h2>
        </div>

        <div className="tool-tabs">
          <button className={`tab-btn ${activeTab === 'stt' ? 'active' : ''}`} onClick={() => setActiveTab('stt')}>Speech To Text</button>
          <button className={`tab-btn ${activeTab === 'tts' ? 'active' : ''}`} onClick={() => setActiveTab('tts')}>Text To Speech</button>
          <button className={`tab-btn ${activeTab === 'translate' ? 'active' : ''}`} onClick={() => setActiveTab('translate')}>Translation</button>
        </div>

        <div className={`tool-panel ${activeTab === 'stt' ? 'active' : ''}`}>
          <div className="tool-grid">
            <div className="tool-input-area">
              <h3>Voice</h3>
              <div className="audio-upload-zone">
                <div className="upload-icon">🎤</div>
                <p>{sttAudioBase64 ? "Audio Captured" : "Record your query"}</p>
                <div className="upload-buttons">
                  <button onClick={handleSttRecord} className={`btn ${sttRecording ? 'btn-danger' : 'btn-accent'}`}>
                    {sttRecording ? 'Stop' : 'Record'}
                  </button>
                  {sttAudioBase64 && <button onClick={() => setSttAudioBase64(null)} className="btn btn-outline">Clear</button>}
                </div>
              </div>
              <button onClick={handleTranscribe} className="btn btn-primary btn-full" disabled={!sttAudioBase64 || sttLoading}>
                {sttLoading ? 'Transcribing...' : 'Transcribe Audio'}
              </button>
            </div>
            <div className="tool-output-area">
              <h3>Transcript</h3>
              <div className="transcript-box">
                {sttTranscript || <p className="placeholder-text">Output text will appear here...</p>}
              </div>
              {sttTranscript && <button onClick={() => navigator.clipboard.writeText(sttTranscript)} className="btn btn-outline btn-small copy-btn">Copy Text</button>}
            </div>
          </div>
        </div>

        <div className={`tool-panel ${activeTab === 'tts' ? 'active' : ''}`}>
          <div className="tool-grid">
            <div className="tool-input-area">
              <h3>Text</h3>
              <textarea 
                value={ttsInput}
                onChange={(e) => setTtsInput(e.target.value)}
                placeholder="Enter text for high-quality TTS..." 
                rows={6}
              ></textarea>
              <button onClick={handleTtsGenerate} className="btn btn-primary btn-full" disabled={ttsLoading}>
                {ttsLoading ? 'Processing...' : 'Generate & Play'}
              </button>
            </div>
            <div className="tool-output-area">
              <h3>Audio Output</h3>
              <div className="audio-output-box">
                {ttsAudioStatus || <p className="placeholder-text">Generated audio status will appear here...</p>}
              </div>
            </div>
          </div>
        </div>

        <div className={`tool-panel ${activeTab === 'translate' ? 'active' : ''}`}>
          <div className="tool-grid">
            <div className="tool-input-area">
              <h3>Source Text</h3>
              <textarea 
                value={translateInput}
                onChange={(e) => setTranslateInput(e.target.value)}
                placeholder="Enter text to translate..." 
                rows={6}
              ></textarea>
              <div className="language-select-tool">
                <label>Target Language:</label>
                <select value={translateTarget} onChange={(e) => setTranslateTarget(e.target.value)}>
                  <option value="ar">Arabic</option>
                  <option value="en">English</option>
                  <option value="ur">Urdu</option>
                  <option value="hi">Hindi</option>
                </select>
              </div>
              <button onClick={handleTranslate} className="btn btn-primary btn-full" disabled={translateLoading}>
                {translateLoading ? 'Translating...' : 'Translate'}
              </button>
            </div>
            <div className="tool-output-area">
              <h3>Translation</h3>
              <div className="transcript-box">
                {translateResult || <p className="placeholder-text">Translated text will appear here...</p>}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="agent" className="agent-section">
        <div className="section-header">
          <span className="section-badge">Voice Solutions</span>
          <h2>Talk to Our AI Voice Agent</h2>
          <p>Real-time voice assistant for Telecom & Hospital support</p>
          {errorMsg && (
            <div style={{
              background: '#fee2e2',
              border: '1px solid var(--danger)',
              padding: '1rem',
              borderRadius: '8px',
              color: 'var(--danger)',
              marginTop: '1.5rem',
              textAlign: 'left',
              maxWidth: '600px',
              margin: '1.5rem auto 0'
            }}>
              <strong>⚠️ {errorMsg}</strong>
            </div>
          )}
        </div>

        <div className="agent-container">
          <div className="agent-card">
            <div className="agent-header">
              <div className="agent-avatar"><span>🤖</span></div>
              <div className="agent-info">
                <h3>Saudi Voice Agent</h3>
                <p>Multi-dialect Specialist</p>
              </div>
              <div className="status-pill">
                <span className={`status-dot ${isConnected ? (status === 'speaking' ? 'speaking' : 'connected') : ''}`}></span>
                <span>{isConnected ? (status === 'thinking' ? 'Thinking...' : status === 'speaking' ? 'Speaking' : 'Listening') : 'Ready'}</span>
              </div>
            </div>

            <div className="agent-controls">
              <div className="language-select-tool">
                <label>Select Dialect:</label>
                <select value={currentDialect.id} onChange={(e) => handleDialectChange(e.target.value as Language)}>
                  {DIALECTS.map(d => (
                    <option key={d.id} value={d.id}>{d.label} {d.flag}</option>
                  ))}
                </select>
              </div>
              <div className="agent-buttons">
                {!isConnected ? (
                  <button onClick={toggleConnection} className="btn btn-accent btn-large btn-full">🎙️ Start Conversation</button>
                ) : (
                  <button onClick={toggleConnection} className="btn btn-outline btn-large btn-full">⏹️ End Call</button>
                )}
              </div>
            </div>

            <div className={`voice-visualizer ${isConnected ? 'active' : ''}`}>
               {[...Array(5)].map((_, i) => (
                 <div 
                   key={i} 
                   className="visualizer-bar" 
                   style={{ 
                     animationDelay: `${i * 0.1}s`, 
                     height: isConnected ? (status === 'speaking' || status === 'listening' ? '80%' : '10%') : '10%' 
                   }}
                 ></div>
               ))}
            </div>

            <div ref={transcriptScrollRef} className="conversation-area">
              {messages.length === 0 && !liveUserSpeech && !liveAssistantSpeech && (
                <div className="conversation-placeholder">
                  <p>Click "Start Conversation" to begin</p>
                  <p className="hint">Ask about telecom billing, hospital bookings, and more.</p>
                </div>
              )}
              
              {messages.map((msg, idx) => (
                <div key={idx} className={`message ${msg.role === 'user' ? 'user' : 'assistant'}`}>
                  <div className="message-label">{msg.role === 'user' ? 'You' : 'Agent'}</div>
                  <div className="message-text" dir="auto">{msg.text}</div>
                </div>
              ))}

              {liveUserSpeech && (
                <div className="message user opacity-70 italic">
                  <div className="message-label">You</div>
                  <div className="message-text" dir="auto">{liveUserSpeech}...</div>
                </div>
              )}

              {liveAssistantSpeech && (
                <div className="message assistant speaking">
                  <div className="message-label">Agent</div>
                  <div className="message-text" dir="auto">{liveAssistantSpeech}</div>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      <footer className="footer">
        <div className="footer-content">
          <div className="logo">
            <span className="logo-icon">🎙️</span>
            <span className="logo-text">Saudi Voice Agent</span>
          </div>
          <p>AI Speech Intelligence for Arabic Dialects & Regional Support</p>
        </div>
      </footer>
    </div>
  );
};

export default App;
