import logger from '../config/logger';

export interface LLMParsedSubscription {
  name: string | null;
  amount: number | null;
  currency: string | null;
  interval: string | null;
  confidence: number;
}

const GEMINI_API_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';

const SYSTEM_PROMPT = `You are a subscription invoice parser. Extract subscription details from the email text below and return ONLY valid JSON with this exact shape:
{
  "name": "<merchant or service name, or null>",
  "amount": <number or null>,
  "currency": "<ISO 4217 code or null>",
  "interval": "<monthly|yearly|weekly|quarterly or null>",
  "confidence": <0.0–1.0 float>
}
Rules:
- confidence >= 0.9 only when name, amount, and interval are all present and unambiguous.
- Return null for any field you cannot determine.
- Do NOT include markdown fences or extra text — raw JSON only.`;

export class LLMParser {
  private apiKey: string | null;

  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY ?? null;
    if (!this.apiKey) {
      logger.warn('LLMParser: GEMINI_API_KEY not set — LLM fallback disabled');
    }
  }

  get isAvailable(): boolean {
    return !!this.apiKey;
  }

  async parse(emailText: string): Promise<LLMParsedSubscription | null> {
    if (!this.apiKey) return null;

    const body = {
      contents: [
        {
          parts: [
            { text: SYSTEM_PROMPT },
            { text: `\n\nEmail text:\n${emailText.slice(0, 8000)}` },
          ],
        },
      ],
      generationConfig: { temperature: 0, maxOutputTokens: 256 },
    };

    try {
      const res = await fetch(`${GEMINI_API_URL}?key=${this.apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        logger.error('LLMParser: Gemini API error', { status: res.status });
        return null;
      }

      const data: any = await res.json();
      const raw: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      const parsed = JSON.parse(raw.trim()) as LLMParsedSubscription;

      logger.info('LLMParser: parsed subscription', {
        name: parsed.name,
        confidence: parsed.confidence,
      });

      return parsed;
    } catch (err) {
      logger.error('LLMParser: failed to parse Gemini response', { err });
      return null;
    }
  }
}

export const llmParser = new LLMParser();
