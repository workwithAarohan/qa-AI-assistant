import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
dotenv.config();

// ── Primary: Gemini 2.5 Flash ─────────────────────────────────────────────────
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const MODELS = [
  { name: 'gemini-2.5-flash',   label: 'Gemini 2.5 Flash'   },
  { name: 'gemini-1.5-flash',   label: 'Gemini 1.5 Flash'   },
  { name: 'gemini-1.5-flash-8b',label: 'Gemini Flash 8B'    },
];

function isRateLimitError(err) {
  const msg = err?.message || '';
  const status = err?.response?.status;
  return status === 429 || msg.includes('429') || msg.includes('quota') || msg.includes('rate');
}

function isRetryableError(err) {
  const status = err?.response?.status || Number((err?.message || '').match(/\b(429|5\d{2})\b/)?.[0]);
  return status === 429 || (status >= 500 && status < 600);
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── FIX 3: Multi-model fallback with exponential backoff ──────────────────────
// Order: gemini-2.5-flash → gemini-1.5-flash → gemini-1.5-flash-8b
// On 429: try next model immediately rather than waiting

export async function generate(prompt, opts = {}) {
  const maxAttemptsPerModel = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;

  for (const modelDef of MODELS) {
    const model = genAI.getGenerativeModel({ model: modelDef.name });

    for (let attempt = 1; attempt <= maxAttemptsPerModel; attempt++) {
      try {
        const result = await model.generateContent(prompt);
        if (modelDef.name !== MODELS[0].name) {
          console.log(`[LLM] Used fallback model: ${modelDef.label}`);
        }
        return result;
      } catch (err) {
        const isRateLimit = isRateLimitError(err);
        const isLastAttempt = attempt === maxAttemptsPerModel;
        const isLastModel = modelDef === MODELS[MODELS.length - 1];

        if (isRateLimit && !isLastModel) {
          // Rate limited — move to next model immediately
          console.warn(`[LLM] ${modelDef.label} rate limited — trying next model`);
          break;
        }

        if (!isRetryableError(err) || isLastAttempt) {
          if (isLastModel) throw err;
          break; // try next model
        }

        const jitter = Math.floor(Math.random() * 300);
        const delay = Math.pow(2, attempt - 1) * baseDelayMs + jitter;
        console.warn(`[LLM] ${modelDef.label} failed (attempt ${attempt}) — retrying in ${delay}ms`);
        await sleep(delay);
      }
    }
  }

  throw new Error('All LLM models failed or rate limited. Please wait a moment and try again.');
}

export default { generate };