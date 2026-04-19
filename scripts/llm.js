import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
dotenv.config();

// ── Primary: Gemini via Google SDK ────────────────────────────────────────────
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const GEMINI_MODELS = [
  { name: 'gemini-2.5-flash',    label: 'Gemini 2.5 Flash'  },
  { name: 'gemini-1.5-flash',    label: 'Gemini 1.5 Flash'  },
  { name: 'gemini-1.5-flash-8b', label: 'Gemini Flash 8B'   },
];

// ── Fallback: HuggingFace Inference Router (OpenAI-compatible) ────────────────
// Uses https://router.huggingface.co/v1 — no extra deps needed, plain fetch.
const HF_MODELS = [
  { id: 'google/gemma-3-27b-it', label: 'Gemma 3 27B' },
  { id: 'google/gemma-3-12b-it', label: 'Gemma 3 12B' },
  { id: 'google/gemma-3-4b-it',  label: 'Gemma 3 4B'  },
];
const HF_BASE = 'https://router.huggingface.co/v1';

function isRateLimitError(err) {
  const msg = (err?.message || '').toLowerCase();
  const status = err?.status || err?.response?.status;
  return status === 429 || msg.includes('429') || msg.includes('quota') || msg.includes('rate') || msg.includes('limit');
}

function isRetryable(err) {
  const status = err?.status || err?.response?.status || Number((err?.message || '').match(/\b(429|5\d{2})\b/)?.[0]);
  return status === 429 || (status >= 500 && status < 600);
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── HuggingFace Chat Completion (plain fetch, OpenAI-compat) ─────────────────
async function hfGenerate(prompt, modelId) {
  const hfToken = process.env.HF_TOKEN;
  if (!hfToken) throw new Error('HF_TOKEN not set — cannot use HuggingFace fallback');

  const response = await fetch(`${HF_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${hfToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4096,
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    const err = new Error(`HuggingFace API error: ${response.status} ${response.statusText}`);
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || '';

  // Return object shaped like Gemini result so callers use same interface
  return {
    response: {
      text: () => text,
    },
    _provider: 'huggingface',
    _model: modelId,
  };
}

// ── HuggingFace fallback chain ────────────────────────────────────────────────
async function tryHuggingFace(prompt) {
  for (const model of HF_MODELS) {
    try {
      const result = await hfGenerate(prompt, model.id);
      console.log(`[LLM] HuggingFace fallback used: ${model.label}`);
      return result;
    } catch (err) {
      const isRateLimit = isRateLimitError(err);
      console.warn(`[LLM] ${model.label} failed: ${err.message}`);
      if (!isRateLimit && err.status !== 503) throw err; // hard error, don't try next
      // rate-limited or unavailable → try next model
    }
  }
  throw new Error('All HuggingFace Gemma models rate-limited or unavailable.');
}

// ── Main export: Gemini primary → HuggingFace Gemma fallback ─────────────────
export async function generate(prompt, opts = {}) {
  const maxAttemptsPerModel = opts.maxAttempts ?? 2;
  const baseDelayMs = opts.baseDelayMs ?? 400;

  // 1. Try Gemini models first
  for (const modelDef of GEMINI_MODELS) {
    const model = genAI.getGenerativeModel({ model: modelDef.name });

    for (let attempt = 1; attempt <= maxAttemptsPerModel; attempt++) {
      try {
        const result = await model.generateContent(prompt);
        if (modelDef.name !== GEMINI_MODELS[0].name) {
          console.log(`[LLM] Gemini fallback used: ${modelDef.label}`);
        }
        return result;
      } catch (err) {
        const isRateLimit = isRateLimitError(err);
        const isLastAttempt = attempt === maxAttemptsPerModel;
        const isLastGemini = modelDef === GEMINI_MODELS[GEMINI_MODELS.length - 1];

        if (isRateLimit) {
          console.warn(`[LLM] ${modelDef.label} rate limited (attempt ${attempt})`);
          if (!isLastGemini) break; // try next Gemini model immediately
          if (isLastGemini) {
            // All Gemini exhausted — fall through to HuggingFace
            console.warn('[LLM] All Gemini models rate-limited → switching to HuggingFace Gemma');
            return tryHuggingFace(prompt);
          }
        }

        if (!isRetryable(err) || isLastAttempt) {
          if (isLastGemini) {
            console.warn(`[LLM] Gemini hard-failed → trying HuggingFace: ${err.message}`);
            return tryHuggingFace(prompt);
          }
          break; // try next Gemini model
        }

        const jitter = Math.floor(Math.random() * 200);
        const delay = Math.pow(2, attempt - 1) * baseDelayMs + jitter;
        console.warn(`[LLM] ${modelDef.label} retry in ${delay}ms`);
        await sleep(delay);
      }
    }
  }

  // Shouldn't reach here, but safety net
  return tryHuggingFace(prompt);
}

// ── Health check helper — useful for the UI status indicator ─────────────────
export async function checkProviderHealth() {
  const results = { gemini: 'unknown', huggingface: 'unknown' };
  try {
    const model = genAI.getGenerativeModel({ model: GEMINI_MODELS[0].name });
    await model.generateContent('ping');
    results.gemini = 'ok';
  } catch (e) {
    results.gemini = isRateLimitError(e) ? 'rate_limited' : 'error';
  }
  if (process.env.HF_TOKEN) results.huggingface = 'configured';
  return results;
}

export default { generate };