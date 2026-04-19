/**
 * llm.js — Multi-provider LLM with smart fallback chain
 *
 * Priority order:
 *   1. Gemini 2.5 Flash  → 2. Gemini 1.5 Flash → 3. Gemini Flash 8B
 *   4. Groq Llama-3.3-70B (free, 6000 req/day)
 *   5. Groq Llama-3.1-8B  (higher rate limits)
 *   6. Cerebras Llama-3.3-70B (free, ultra-fast 1800 tok/s)
 *   7. HuggingFace Qwen2.5-7B (last resort, needs HF_TOKEN)
 *
 * .env keys needed:
 *   GEMINI_API_KEY   — required (primary)
 *   GROQ_API_KEY     — free at console.groq.com   (best fallback)
 *   CEREBRAS_API_KEY — free at cloud.cerebras.ai  (fast fallback)
 *   HF_TOKEN         — optional, last resort
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const GEMINI_MODELS = [
  { name: 'gemini-2.5-flash',    label: 'Gemini 2.5 Flash'  },
  { name: 'gemini-1.5-flash',    label: 'Gemini 1.5 Flash'  },
  { name: 'gemini-1.5-flash-8b', label: 'Gemini Flash 8B'   },
];

const EXTERNAL_PROVIDERS = [
  {
    label:     'Groq / Llama-3.3-70B',
    baseUrl:   'https://api.groq.com/openai/v1',
    apiKey:    () => process.env.GROQ_API_KEY,
    model:     'llama-3.3-70b-versatile',
    maxTokens: 4096,
  },
  {
    label:     'Groq / Llama-3.1-8B',
    baseUrl:   'https://api.groq.com/openai/v1',
    apiKey:    () => process.env.GROQ_API_KEY,
    model:     'llama-3.1-8b-instant',
    maxTokens: 4096,
  },
  {
    label:     'Cerebras / Llama-3.3-70B',
    baseUrl:   'https://api.cerebras.ai/v1',
    apiKey:    () => process.env.CEREBRAS_API_KEY,
    model:     'llama-3.3-70b',
    maxTokens: 4096,
  },
  {
    label:     'HuggingFace / Qwen2.5-7B',
    baseUrl:   'https://router.huggingface.co/hf-inference/v1',
    apiKey:    () => process.env.HF_TOKEN,
    model:     'Qwen/Qwen2.5-7B-Instruct',
    maxTokens: 2048,
  },
];

function isRateLimit(err) {
  const msg = (err?.message || '').toLowerCase();
  const status = err?.status || err?.response?.status;
  return status === 429 || msg.includes('429') || msg.includes('quota') || msg.includes('rate') || msg.includes('limit');
}

function isRetryable(err) {
  const status = err?.status || err?.response?.status
    || Number((err?.message || '').match(/\b(429|5\d{2})\b/)?.[0]);
  return status === 429 || (status >= 500 && status < 600);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callExternal(provider, prompt) {
  const key = provider.apiKey();
  if (!key) throw new Error(`${provider.label}: key not configured`);

  const res = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model:      provider.model,
      messages:   [{ role: 'user', content: prompt }],
      max_tokens: provider.maxTokens,
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`${provider.label} HTTP ${res.status}: ${body.slice(0, 140)}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';
  return { response: { text: () => text }, _provider: provider.label };
}

async function tryExternalChain(prompt) {
  const tried = [];
  for (const p of EXTERNAL_PROVIDERS) {
    if (!p.apiKey()) continue; // skip unconfigured providers
    try {
      const r = await callExternal(p, prompt);
      console.log(`[LLM] ✓ Fallback: ${p.label}`);
      return r;
    } catch (err) {
      console.warn(`[LLM] ✗ ${p.label}: ${err.message}`);
      tried.push(p.label);
    }
  }
  throw new Error(
    `All providers exhausted (tried: ${tried.join(', ') || 'none configured'}).\n` +
    'Add GROQ_API_KEY (free: console.groq.com) or CEREBRAS_API_KEY (free: cloud.cerebras.ai) to .env'
  );
}

export async function generate(prompt, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? 2;
  const baseDelay   = opts.baseDelayMs  ?? 400;

  for (const modelDef of GEMINI_MODELS) {
    const model = genAI.getGenerativeModel({ model: modelDef.name });

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await model.generateContent(prompt);
        if (modelDef.name !== GEMINI_MODELS[0].name) {
          console.log(`[LLM] ✓ Gemini fallback: ${modelDef.label}`);
        }
        return result;
      } catch (err) {
        const rl   = isRateLimit(err);
        const last = attempt === maxAttempts;
        const lastG = modelDef === GEMINI_MODELS[GEMINI_MODELS.length - 1];

        if (rl) {
          console.warn(`[LLM] ✗ ${modelDef.label} rate-limited`);
          if (lastG) { console.warn('[LLM] All Gemini exhausted → external'); return tryExternalChain(prompt); }
          break; // try next Gemini
        }

        if (!isRetryable(err) || last) {
          if (lastG) { console.warn(`[LLM] Gemini error → external: ${err.message}`); return tryExternalChain(prompt); }
          break;
        }

        const delay = 2 ** (attempt - 1) * baseDelay + Math.floor(Math.random() * 200);
        console.warn(`[LLM] Retry ${attempt} in ${delay}ms`);
        await sleep(delay);
      }
    }
  }

  return tryExternalChain(prompt);
}

export default { generate };