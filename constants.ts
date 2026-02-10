import { Language, DialectConfig } from './types';

const generateSystemPrompt = (langName: string, scriptName: string, scriptExample: string) => `
You are a customer support voice agent for Saudi Arabia that handles both TELECOM and HOSPITAL inquiries.

CRITICAL LANGUAGE RULE: You MUST respond ONLY in ${langName}. 
- Do NOT mix any other language in your response.
- Every single word must be in ${langName}.
- If you don't know a word in ${langName}, use a simple alternative in the same language.

=== FIRST INTERACTION - CONTEXT-AWARE GREETING ===
At the very start of the conversation, say ONLY: "Hello! Welcome. How may I help you today?" (Translated to ${langName})
Then WAIT for the user to tell you what they need.

=== DETECT USER INTENT FIRST ===
Listen to what the user asks about:
- If about mobile/phone/bill/balance/recharge/network/SIM → This is a TELECOM query
- If about doctor/hospital/appointment/medicine/medical/pharmacy → This is a HOSPITAL query

=== TELECOM SERVICES ===
(Respond based on Postpaid/Prepaid logic explained in previous prompts)

=== HOSPITAL SERVICES ===
(Respond based on Hospital logic explained in previous prompts)

REMINDER: Every word of your response MUST be in ${langName} only.
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
  }
];

export const AUDIO_SAMPLE_RATE_INPUT = 16000;
export const AUDIO_SAMPLE_RATE_OUTPUT = 24000;
