
import { Language, DialectConfig } from './types';

const generateSystemPrompt = (langName: string, scriptName: string, scriptExample: string) => `
You are a professional customer support voice agent for a Saudi Arabian telecom and hospital group.

=== CRITICAL LANGUAGE & SCRIPT ENFORCEMENT ===
- Target Language: ${langName}
- Target Script: ${scriptName} (e.g., ${scriptExample})
- TRANSCRIPTION RULE: You MUST transcribe the user's speech using ONLY the ${scriptName} script. 
- If the user speaks English but the session is ${langName}, translate the intent but keep your transcript in ${scriptName} or ${langName}.
- NEVER use characters from a different language's script in your output or transcriptions.

=== SHARED KNOWLEDGE BASE (MANDATORY FOR ALL LANGUAGES) ===

1. GREETING:
   - On connection, greet the user: "Hello! Welcome to Saudi Voice Intelligence. How can I help you today?" (Always translated to ${langName}).

2. TELECOM LOGIC:
   - We handle billing and SIM inquiries.
   - If a user asks about their bill or balance:
     - ASK: "Please provide your mobile number."
     - LOGIC: 
       - If number ends in "10": It is a POSTPAID account. Tell them: "Your bill is 250 SAR."
       - Otherwise: It is a PREPAID account. Tell them: "Your balance is 45 SAR."

3. HOSPITAL LOGIC:
   - We provide: Appointments, Doctor Consultations, and Medical Reports.
   - Location: King Fahd Road, Riyadh.
   - Hours: Open 24/7.
   - Departments: Cardiology, Pediatrics, General Medicine, Orthopedics.

=== CONSTRAINTS ===
- Be extremely brief. This is a voice interface.
- Never mention you are an AI.
- All currency MUST be in SAR.
`;

export const DIALECTS: DialectConfig[] = [
  {
    id: Language.ENGLISH,
    label: 'English',
    flag: '🇬🇧',
    initialGreeting: 'Hello! Welcome. How may I help you today?',
    systemPrompt: generateSystemPrompt('English', 'Latin/English', 'A, B, C')
  },
  {
    id: Language.SAUDI,
    label: 'Saudi Arabic',
    flag: '🇸🇦',
    initialGreeting: 'أهلاً بك! كيف أقدر أخدمك اليوم؟',
    systemPrompt: generateSystemPrompt('Saudi Arabic', 'Arabic', 'أ، ب، ج')
  },
  {
    id: Language.URDU,
    label: 'Urdu',
    flag: '🇵🇰',
    initialGreeting: 'خوش آمدید! میں آج آپ کی کیا مدد کر سکتا ہوں؟',
    systemPrompt: generateSystemPrompt('Urdu', 'Urdu/Arabic-based', 'ا، ب، ج')
  },
  {
    id: Language.HINDI,
    label: 'Hindi',
    flag: '🇮🇳',
    initialGreeting: 'नमस्ते! स्वागत है। मैं आज आपकी क्या मदद कर सकता हूँ?',
    systemPrompt: generateSystemPrompt('Hindi', 'Devanagari', 'अ, ब, स')
  },
  {
    id: Language.LEBANESE,
    label: 'Lebanese Arabic',
    flag: '🇱🇧',
    initialGreeting: 'أهلاً بك! كيف فيني ساعدك اليوم؟',
    systemPrompt: generateSystemPrompt('Lebanese Arabic', 'Arabic', 'أ، ب، ج')
  },
  {
    id: Language.IRAQI,
    label: 'Iraqi Arabic',
    flag: '🇮🇶',
    initialGreeting: 'أهلاً بك! شلون أگدر أساعدك اليوم؟',
    systemPrompt: generateSystemPrompt('Iraqi Arabic', 'Arabic', 'أ، ب، ج')
  },
  {
    id: Language.EMIRATI,
    label: 'Emirati Arabic',
    flag: '🇦🇪',
    initialGreeting: 'أهلاً بك! شو نقدر نساعدك فيه اليوم؟',
    systemPrompt: generateSystemPrompt('Emirati Arabic', 'Arabic', 'أ، ب، ج')
  },
  {
    id: Language.EGYPTIAN,
    label: 'Egyptian Arabic',
    flag: '🇪🇬',
    initialGreeting: 'أهلاً بك! أقدر أساعدك إزاي النهاردة؟',
    systemPrompt: generateSystemPrompt('Egyptian Arabic', 'Arabic', 'أ، ب، ج')
  },
  {
    id: Language.JORDANIAN,
    label: 'Jordanian Arabic',
    flag: '🇯🇴',
    initialGreeting: 'أهلاً بك! كيف بنقدر نساعدك اليوم؟',
    systemPrompt: generateSystemPrompt('Jordanian Arabic', 'Arabic', 'أ، ب، ج')
  },
  {
    id: Language.KUWAITI,
    label: 'Kuwaiti Arabic',
    flag: '🇰🇼',
    initialGreeting: 'أهلاً بك! شلون أقدر أساعدك اليوم؟',
    systemPrompt: generateSystemPrompt('Kuwaiti Arabic', 'Arabic', 'أ، ب، ج')
  }
];

export const AUDIO_SAMPLE_RATE_INPUT = 16000;
export const AUDIO_SAMPLE_RATE_OUTPUT = 24000;
