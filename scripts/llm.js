/**
 * llm.js — Two-tier LLM provider
 *
 * Primary:  Gemini 2.5 Flash (google/gemini-2.5-flash)
 * Fallback: HuggingFace Inference API — Gemma 3 27B → 12B → 4B
 *
 * Both tiers return the same shape:
 *   { response: { text: () => string } }
 * so callers never need to branch on provider.
 *
 * .env keys:
 *   GEMINI_API_KEY  — required (primary)
 *   HF_TOKEN        — required for fallback (huggingface.co → Access Tokens)
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ── Gemini primary model ───────────────────────────────────────────────────────
const GEMINI_MODEL = 'gemini-2.5-flash';

// ── HuggingFace fallback models (tried in order) ──────────────────────────────
// Using the OpenAI-compatible inference endpoint so we get the same
// chat/completions response shape regardless of model.
const HF_ENDPOINT = 'https://router.huggingface.co/v1/chat/completions';
const HF_MODELS = [
  { id: 'zai-org/GLM-5.1:together', label: 'GLM' },
];

// ── Error helpers ──────────────────────────────────────────────────────────────
function isRateLimit(err) {
  const msg = String(err?.message || '').toLowerCase();
  const s   = err?.status ?? err?.response?.status;
  return s === 429 || msg.includes('429') || msg.includes('quota')
      || msg.includes('rate') || msg.includes('exhausted');
}

function isRetryable(err) {
  const s = Number(
    err?.status ?? err?.response?.status
    ?? (String(err?.message || '').match(/\b(429|5\d{2})\b/) || [])[0]
  );
  return s === 429 || (s >= 500 && s < 600);
}

function isUnavailable(err) {
  const msg = String(err?.message || '').toLowerCase();
  const s   = err?.status ?? err?.response?.status;
  return s === 503 || s === 404 || msg.includes('loading') || msg.includes('unavailable');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── HuggingFace caller ─────────────────────────────────────────────────────────
// Wraps the HF response in { response: { text: () => string } }
// so it is identical in shape to what model.generateContent() returns.
async function callHuggingFace(prompt, modelId) {
  const token = process.env.HF_TOKEN;
  if (!token) throw new Error('HF_TOKEN is not set in .env');

  const res = await fetch(HF_ENDPOINT, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      model:       modelId,
      messages:    [{ role: 'user', content: prompt }],
      max_tokens:  4096,
      temperature: 0.1,   // low temperature — we always want valid JSON back
      stream:      false,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err  = new Error(`HF HTTP ${res.status} (${modelId}): ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }

  const json    = await res.json();
  const content = json?.choices?.[0]?.message?.content ?? '';

  if (!content) throw new Error(`HF returned empty content from ${modelId}`);

  // Return the same shape as Gemini's result object
  return {
    response: { text: () => content },
    _via:     'huggingface',
    _model:   modelId,
  };
}

// ── HuggingFace cascade ────────────────────────────────────────────────────────
async function tryHuggingFace(prompt, maxTries, base) {
  if (!process.env.HF_TOKEN) {
    throw new Error(
      'Gemini 2.5 Flash is rate-limited and HF_TOKEN is not set.\n' +
      'Add HF_TOKEN=<your_token> to .env to enable the Gemma fallback.\n' +
      'Get a free token at: https://huggingface.co/settings/tokens'
    );
  }

  console.log('[LLM] Gemini rate-limited → falling back to HuggingFace Gemma...');

  for (const hf of HF_MODELS) {
    for (let t = 1; t <= maxTries; t++) {
      try {
        const result = await callHuggingFace(prompt, hf.id);
        console.log(`[LLM] ✓ Response via HuggingFace ${hf.label}`);
        return result;
      } catch (err) {
        const lastTry = t === maxTries;
        const lastHF  = hf === HF_MODELS.at(-1);

        if (isRateLimit(err) || isUnavailable(err)) {
          console.warn(`[LLM] ✗ ${hf.label}: ${err.message}`);
          break; // try next HF model immediately
        }

        if (!isRetryable(err) || lastTry) {
          console.warn(`[LLM] ✗ ${hf.label}: ${err.message}`);
          if (!lastHF) break; // try next HF model
          throw new Error(`All HuggingFace models exhausted. Last error: ${err.message}`);
        }

        const delay = Math.pow(2, t - 1) * base;
        console.warn(`[LLM] ${hf.label} retry ${t} in ${delay}ms`);
        await sleep(delay);
      }
    }
  }

  throw new Error('All HuggingFace fallback models are unavailable. Please wait and retry.');
}

// ── Main export ────────────────────────────────────────────────────────────────
export async function generate(prompt, opts = {}) {
  const maxTries = opts.maxAttempts ?? 2;
  const base     = opts.baseDelayMs ?? 500;

  // ── Tier 1: Gemini 2.5 Flash ─────────────────────────────────────────────
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

  for (let t = 1; t <= maxTries; t++) {
    try {
      const result = await model.generateContent(prompt);
      return result; // native Gemini result — callers use result.response.text()
    } catch (err) {
      const lastTry = t === maxTries;

      if (isRateLimit(err)) {
        console.warn(`[LLM] Gemini 2.5 Flash rate-limited (attempt ${t})`);
        if (lastTry) break; // fall through to HuggingFace
        const delay = Math.pow(2, t - 1) * base + Math.random() * 200;
        console.warn(`[LLM] Retrying Gemini in ${Math.round(delay)}ms...`);
        await sleep(delay);
        continue;
      }

      // Non-rate-limit error — log and go straight to fallback
      console.warn(`[LLM] Gemini error: ${err.message}`);
      break;
    }
  }

  // ── Tier 2: HuggingFace Gemma ─────────────────────────────────────────────
  return tryHuggingFace(prompt, maxTries, base);
}

export default { generate };