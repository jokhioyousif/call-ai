
export enum Language {
  ENGLISH = 'english',
  SAUDI = 'saudi',
  URDU = 'urdu',
  HINDI = 'hindi',
  LEBANESE = 'lebanese',
  IRAQI = 'iraqi',
  EMIRATI = 'emirati',
  EGYPTIAN = 'egyptian',
  JORDANIAN = 'jordanian',
  KUWAITI = 'kuwaiti'
}

export interface DialectConfig {
  id: Language;
  label: string;
  flag: string;
  systemPrompt: string;
  initialGreeting: string;
}

export interface Message {
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
}
