
import { Language, DialectConfig } from './types';

const generateSystemPrompt = (langName: string, scriptRule: string) => `
You are a professional customer support voice agent for a Saudi Arabian telecom and hospital service. 

=== CRITICAL LANGUAGE & SCRIPT ENFORCEMENT ===
- Target Language: ${langName}
- ${scriptRule}
- You MUST respond ONLY in ${langName}.
- TRANSCRIPTION RULE: When processing user audio, you MUST transcribe it strictly using the ${langName} script. Never use characters from other languages.
- If you are confused by the input, ask for clarification in ${langName}.

=== WORKFLOW LOGIC ===

1. GREETING:
   - On start, say: "Hello! Welcome to Saudi Voice Intelligence. How can I assist you today?" (translated to ${langName}).
   - Wait for user response.

2. TELECOM INTENT (Bill, Balance, SIM, Network):
   - Ask for their mobile number.
   - If number ends in "10": It is a POSTPAID account. Tell them their bill is 250 SAR.
   - Otherwise: It is a PREPAID account. Tell them their balance is 45 SAR.

3. HOSPITAL INTENT (Doctor, Appointment, Medical):
   - We offer: Appointment booking, doctor consultations, and medical reports.
   - Location: King Fahd Road, Riyadh. Open 24/7.

=== GENERAL RULES ===
- Be extremely concise. This is a voice conversation.
- Never mention you are an AI.
- All currency must be in SAR.
`;

export const DIALECTS: DialectConfig[] = [
  {
    id: Language.ENGLISH,
    label: 'English',
    flag: '🇬🇧',
    initialGreeting: 'Hello! Welcome. How may I help you today?',
    systemPrompt: generateSystemPrompt('English', 'Use ONLY Latin/English characters. Never use Arabic, Hindi, or Urdu scripts.')
  },
  {
    id: Language.SAUDI,
    label: 'Saudi Arabic',
    flag: '🇸🇦',
    initialGreeting: 'أهلاً بك! كيف أقدر أخدمك اليوم؟',
    systemPrompt: generateSystemPrompt('Saudi Arabic', 'Use ONLY Arabic script. Never use English or Hindi characters.')
  },
  {
    id: Language.URDU,
    label: 'Urdu',    flag: '🇵🇰',
    initialGreeting: 'خوش آمدید! میں آج آپ کی کیا مدد کر سکتا ہوں؟',
    systemPrompt: generateSystemPrompt('Urdu', 'Use ONLY Urdu/Arabic script. Never use English or Devanagari characters.')
  },
  {
    id: Language.HINDI,
    label: 'Hindi',
    flag: '🇮🇳',
    initialGreeting: 'नमस्ते! स्वागत है। मैं आज आपकी क्या मदद कर सकता हूँ?',
    systemPrompt: generateSystemPrompt('Hindi', 'Use ONLY Devanagari script. Never use English or Arabic characters.')
  },
  {
    id: Language.LEBANESE,
    label: 'Lebanese Arabic',
    flag: '🇱🇧',
    initialGreeting: 'أهلاً بك! كيف فيني ساعدك اليوم؟',
    systemPrompt: generateSystemPrompt('Lebanese Arabic', 'Use ONLY Arabic script.')
  },
  {
    id: Language.IRAQI,
    label: 'Iraqi Arabic',
    flag: '🇮🇶',
    initialGreeting: 'أهلاً بك! شلون أگدر أساعدك اليوم؟',
    systemPrompt: generateSystemPrompt('Iraqi Arabic', 'Use ONLY Arabic script.')
  },
  {
    id: Language.EMIRATI,
    label: 'Emirati Arabic',
    flag: '🇦🇪',
    initialGreeting: 'أهلاً بك! شو نقدر نساعدك فيه اليوم؟',
    systemPrompt: generateSystemPrompt('Emirati Arabic', 'Use ONLY Arabic script.')
  },
  {
    id: Language.EGYPTIAN,
    label: 'Egyptian Arabic',
    flag: '🇪🇬',
    initialGreeting: 'أهلاً بك! أقدر أساعدك إزاي النهاردة؟',
    systemPrompt: generateSystemPrompt('Egyptian Arabic', 'Use ONLY Arabic script.')
  },
  {
    id: Language.JORDANIAN,
    label: 'Jordanian Arabic',
    flag: '🇯🇴',
    initialGreeting: 'أهلاً بك! كيف بنقدر نساعدك اليوم؟',
    systemPrompt: generateSystemPrompt('Jordanian Arabic', 'Use ONLY Arabic script.')
  },
  {
    id: Language.KUWAITI,
    label: 'Kuwaiti Arabic',
    flag: '🇰🇼',
    initialGreeting: 'أهلاً بك! شلون أقدر أساعدك اليوم؟',
    systemPrompt: generateSystemPrompt('Kuwaiti Arabic', 'Use ONLY Arabic script.')
  }
];

export const AUDIO_SAMPLE_RATE_INPUT = 16000;
export const AUDIO_SAMPLE_RATE_OUTPUT = 24000;
