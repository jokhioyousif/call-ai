
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
  // Ensure the byte buffer length is even for Int16Array
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
    if (transcriptScrollRef.current) {
      transcriptScrollRef.current.scrollTop = transcriptScrollRef.current.scrollHeight;
    }
  }, [messages, liveUserSpeech, liveAssistantSpeech]);

  const stopSession = useCallback(() => {
    console.log("[DEBUG] Stopping session and cleaning up resources...");
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
    console.log("[DEBUG] Starting new session for:", dialect.label);
    setErrorMsg(null);
    setStatus('thinking');

    if (!process.env.API_KEY) {
      const err = "API Key is missing. Check Railway environment variables.";
      console.error("[DEBUG]", err);
      setErrorMsg(err);
      setStatus('idle');
      return;
    }

    try {
      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: AUDIO_SAMPLE_RATE_INPUT });
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: AUDIO_SAMPLE_RATE_OUTPUT });
      
      // Resume contexts immediately to avoid "suspended" state issues in browsers
      await inputCtx.resume();
      await outputCtx.resume();
      
      inputAudioContextRef.current = inputCtx;
      outputAudioContextRef.current = outputCtx;

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      console.log("[DEBUG] Microphone access granted.");

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
            console.log("[DEBUG] WebSocket Connected (onopen)");
            setIsConnected(true);
            setStatus('listening');
            nextStartTimeRef.current = 0;
            
            // Nudge the model to speak the initial greeting
            sessionPromise.then(session => {
              if (session) {
                console.log("[DEBUG] Sending initial nudge text to trigger greeting.");
                session.sendRealtimeInput({ text: "hello" });
              }
            });

            const source = inputCtx.createMediaStreamSource(stream);
            const scriptProcessor = inputCtx.createScriptProcessor(2048, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              sessionPromise.then((session) => {
                if (session) session.sendRealtimeInput({ media: pcmBlob });
              });
            };
            
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            console.log("[DEBUG] Model Message Keys:", Object.keys(message));
            
            if (message.serverContent?.outputTranscription) {
              currentOutputTranscription.current += message.serverContent.outputTranscription.text;
              setLiveAssistantSpeech(currentOutputTranscription.current);
            } else if (message.serverContent?.inputTranscription) {
              currentInputTranscription.current += message.serverContent.inputTranscription.text;
              setLiveUserSpeech(currentInputTranscription.current);
            }

            if (message.serverContent?.turnComplete) {
              const u = currentInputTranscription.current.trim();
              const a = currentOutputTranscription.current.trim();
              if (u || a) {
                setMessages(prev => [
                  ...prev,
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
                  const audioData = decode(part.inlineData.data);
                  const audioBuffer = await decodeAudioData(audioData, outputCtx, AUDIO_SAMPLE_RATE_OUTPUT, 1);
                  const source = outputCtx.createBufferSource();
                  source.buffer = audioBuffer;
                  source.connect(outputCtx.destination);
                  source.onended = () => {
                    sourcesRef.current.delete(source);
                    if (sourcesRef.current.size === 0) setStatus('listening');
                  };
                  source.start(Math.max(nextStartTimeRef.current, outputCtx.currentTime));
                  nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputCtx.currentTime) + audioBuffer.duration;
                  sourcesRef.current.add(source);
                }
              }
            }

            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              setLiveAssistantSpeech('');
              setStatus('listening');
            }
          },
          onerror: (e) => { 
            console.error('[DEBUG] Live API Error:', e); 
            setErrorMsg("Connection issue detected.");
            stopSession(); 
          },
          onclose: (e) => { 
            console.log("[DEBUG] Live API Connection Closed:", e.code, e.reason);
            setIsConnected(false); 
            setStatus('idle'); 
          }
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      console.error('[DEBUG] Start session failed:', err);
      setErrorMsg(err.message || "Failed to connect.");
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

  // --- STT / TTS Tool Handlers ---
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
      } catch (err) { alert("Microphone failed."); }
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
            { text: `Transcribe this audio strictly. Language: ${currentDialect.label}.` }
          ]
        }
      });
      setSttTranscript(response.text || "No transcription.");
    } catch (err) { setSttTranscript("Error."); } finally { setSttLoading(false); }
  };

  const handleTtsGenerate = async () => {
    if (!ttsInput.trim()) return;
    setTtsLoading(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: ttsInput }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
        },
      });
      const b64 = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (b64) {
        const ctx = new AudioContext();
        const buf = await decodeAudioData(decode(b64), ctx, 24000, 1);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start();
        setTtsAudioStatus("Playing...");
      }
    } catch (err) { alert("TTS Failed."); } finally { setTtsLoading(false); }
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
    } catch (err) { setTranslateResult("Error."); } finally { setTranslateLoading(false); }
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
            AI Models<br />Mastering<br />
            <span className="gradient-text">Arabic Dialects</span>
          </h1>
          <p className="hero-subtitle">Telecommunications & Hospital AI Intelligence</p>
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
                <p>{sttAudioBase64 ? "Audio Captured" : "Record your query"}</p>
                <button onClick={handleSttRecord} className={`btn ${sttRecording ? 'btn-danger' : 'btn-accent'}`}>
                  {sttRecording ? 'Stop' : 'Record'}
                </button>
              </div>
              <button onClick={handleTranscribe} className="btn btn-primary btn-full" disabled={!sttAudioBase64 || sttLoading}>
                {sttLoading ? 'Transcribing...' : 'Transcribe'}
              </button>
            </div>
            <div className="tool-output-area">
              <h3>Transcript</h3>
              <div className="transcript-box">{sttTranscript || "Output here..."}</div>
            </div>
          </div>
        </div>

        <div className={`tool-panel ${activeTab === 'tts' ? 'active' : ''}`}>
          <div className="tool-grid">
            <div className="tool-input-area">
              <textarea value={ttsInput} onChange={(e) => setTtsInput(e.target.value)} placeholder="Text for TTS..." rows={4}></textarea>
              <button onClick={handleTtsGenerate} className="btn btn-primary btn-full" disabled={ttsLoading}>Generate & Play</button>
            </div>
            <div className="tool-output-area">
              <div className="audio-output-box">{ttsAudioStatus || "Audio status..."}</div>
            </div>
          </div>
        </div>

        <div className={`tool-panel ${activeTab === 'translate' ? 'active' : ''}`}>
          <div className="tool-grid">
            <div className="tool-input-area">
              <textarea value={translateInput} onChange={(e) => setTranslateInput(e.target.value)} placeholder="Translate..." rows={4}></textarea>
              <select value={translateTarget} onChange={(e) => setTranslateTarget(e.target.value)}>
                <option value="ar">Arabic</option><option value="en">English</option>
              </select>
              <button onClick={handleTranslate} className="btn btn-primary btn-full" disabled={translateLoading}>Translate</button>
            </div>
            <div className="tool-output-area">
              <div className="transcript-box">{translateResult || "Result here..."}</div>
            </div>
          </div>
        </div>
      </section>

      <section id="agent" className="agent-section">
        <div className="agent-container">
          <div className="agent-card">
            <div className="agent-header">
              <div className="agent-avatar">🤖</div>
              <div className="agent-info">
                <h3>Saudi Voice Agent</h3>
                <p>{currentDialect.label} Specialist</p>
              </div>
              <div className="status-pill">
                <span className={`status-dot ${isConnected ? 'connected' : ''} ${status === 'speaking' ? 'speaking' : ''}`}></span>
                <span>{isConnected ? status.toUpperCase() : 'READY'}</span>
              </div>
            </div>

            <div className="agent-controls">
              <select value={currentDialect.id} onChange={(e) => handleDialectChange(e.target.value as Language)}>
                {DIALECTS.map(d => <option key={d.id} value={d.id}>{d.label} {d.flag}</option>)}
              </select>
              <button onClick={toggleConnection} className={`btn btn-full btn-large ${isConnected ? 'btn-outline' : 'btn-accent'}`}>
                {isConnected ? '⏹️ End Call' : '🎙️ Start Conversation'}
              </button>
            </div>

            <div className={`voice-visualizer ${isConnected ? 'active' : ''}`}>
               {[...Array(5)].map((_, i) => <div key={i} className="visualizer-bar"></div>)}
            </div>

            <div ref={transcriptScrollRef} className="conversation-area">
              {messages.map((msg, idx) => (
                <div key={idx} className={`message ${msg.role}`}>
                  <div className="message-label">{msg.role.toUpperCase()}</div>
                  <div className="message-text" dir="auto">{msg.text}</div>
                </div>
              ))}
              {liveUserSpeech && <div className="message user opacity-50"><i>{liveUserSpeech}...</i></div>}
              {liveAssistantSpeech && <div className="message assistant"><b>Agent:</b> {liveAssistantSpeech}</div>}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};

export default App;
