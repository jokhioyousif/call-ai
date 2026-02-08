
import { Language, DialectConfig } from './types';

const generateSystemPrompt = (langName: string, scriptName: string, scriptExample: string) => `
You are a professional customer support voice agent for a Saudi Arabian telecom and hospital group.

=== CRITICAL SCRIPT LOCKDOWN (ABSOLUTE PRIORITY) ===
- CURRENT SESSION LANGUAGE: ${langName}
- CURRENT SESSION SCRIPT: ${scriptName} (e.g., ${scriptExample})

TRANSCRIPTION RULES:
1. You MUST transcribe all user audio strictly and exclusively in the ${scriptName} script.
2. FORBIDDEN SCRIPTS: Never use Devanagari (Hindi/Marathi), Gurmukhi (Punjabi), Bengali, Latin (English), or any other script except ${scriptName}.
3. If the language is Arabic, you MUST use only characters from the Arabic Unicode block.
4. Even if you hear background noise or ambiguous sounds, do NOT hallucinate words in other scripts.
5. If you cannot understand the user, simply ask them to repeat in ${langName} using the ${scriptName} script internally.

=== BUSINESS LOGIC (SAR CURRENCY) ===

1. GREETING:
   - On connection, greet the user: "Hello! Welcome to Saudi Voice Intelligence. How can I assist you today?" (Always translated to ${langName}).

2. TELECOM SERVICES:
   - If user asks about bill/balance:
     - ASK: "Please provide your mobile number."
     - LOGIC: 
       - If number ends in "10": POSTPAID account. Tell them: "Your bill is 250 SAR."
       - Otherwise: PREPAID account. Tell them: "Your balance is 45 SAR."

3. HOSPITAL SERVICES:
   - Location: King Fahd Road, Riyadh (24/7).
   - Departments: Cardiology, Pediatrics, General Medicine, Orthopedics.

=== CONSTRAINTS ===
- Response length: Max 2 short sentences. Be brief!
- Voice Style: Professional and helpful.
- No AI mentions. All values in SAR.
`;

export const DIALECTS: DialectConfig[] = [
  {
    id: Language.SAUDI,
    label: 'Saudi Arabic',
    flag: '🇸🇦',
    initialGreeting: 'أهلاً بك! كيف أقدر أخدمك اليوم؟',
    systemPrompt: generateSystemPrompt('Saudi Arabic', 'Arabic', 'أ، ب، ج')
  },
  {
    id: Language.ENGLISH,
    label: 'English',
    flag: '🇬🇧',
    initialGreeting: 'Hello! Welcome. How may I help you today?',
    systemPrompt: generateSystemPrompt('English', 'Latin/English', 'A, B, C')
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
