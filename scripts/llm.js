/**
 * llm.js — Two-tier LLM provider
 *
 * Primary:  Gemini 2.5 Flash  (cloud, requires GEMINI_API_KEY)
 * Fallback: Ollama GLM-4      (local, zero cost, zero auth)
 *
 * Both tiers return the identical shape:
 *   { response: { text: () => string } }
 * so every caller in agent.js / classifier.js / context-gatherer.js
 * works without any changes.
 *
 * Setup for fallback:
 *   1. Install Ollama: https://ollama.com
 *   2. Pull the model: ollama pull glm4
 *   3. Ollama runs automatically on http://localhost:11434
 *   No tokens, no API keys, no rate limits.
 *
 * .env keys:
 *   GEMINI_API_KEY   — required (primary)
 *   OLLAMA_HOST      — optional, default: http://localhost:11434
 *   OLLAMA_MODEL     — optional, default: glm4
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
dotenv.config();

// ── Gemini setup ───────────────────────────────────────────────────────────────
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const GEMINI_MODEL = 'gemini-2.5-flash';

// ── Ollama setup ───────────────────────────────────────────────────────────────
// Ollama exposes an OpenAI-compatible endpoint — same shape, no auth required.
const OLLAMA_HOST  = (process.env.OLLAMA_HOST  || 'http://localhost:11434').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL  || 'gemma4';
const OLLAMA_URL   = `${OLLAMA_HOST}/v1/chat/completions`;

// ── Error helpers ──────────────────────────────────────────────────────────────
function isRateLimit(err) {
  const msg = String(err?.message || '').toLowerCase();
  const s   = err?.status ?? err?.response?.status;
  return s === 429
    || msg.includes('429')
    || msg.includes('quota')
    || msg.includes('rate limit')
    || msg.includes('exhausted');
}

function isRetryable(err) {
  const s = Number(
    err?.status
    ?? err?.response?.status
    ?? (String(err?.message || '').match(/\b(429|5\d{2})\b/) || [])[0]
  );
  return s === 429 || (s >= 500 && s < 600);
}

function isOllamaUnavailable(err) {
  const msg = String(err?.message || '').toLowerCase();
  // Ollama not running, model not pulled, or connection refused
  return msg.includes('econnrefused')
    || msg.includes('fetch failed')
    || msg.includes('failed to fetch')
    || msg.includes('model not found')
    || msg.includes('enotfound')
    || (err?.status === 404);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Ollama caller ──────────────────────────────────────────────────────────────
// Uses Ollama's OpenAI-compatible /v1/chat/completions endpoint.
// Returns { response: { text: () => string } } — identical to Gemini's shape.
async function callOllama(prompt) {
  const res = await fetch(OLLAMA_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model:       OLLAMA_MODEL,
      messages:    [{ role: 'user', content: prompt }],
      temperature: 0.1,   // low temp — we always want deterministic JSON back
      stream:      false,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err  = new Error(`Ollama HTTP ${res.status}: ${body.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }

  const json    = await res.json();
  const content = json?.choices?.[0]?.message?.content ?? '';

  if (!content) {
    throw new Error(`Ollama returned empty content (model: ${OLLAMA_MODEL})`);
  }

  return {
    response: { text: () => content },
    _via:     'ollama',
    _model:   OLLAMA_MODEL,
  };
}

// ── Ollama fallback ────────────────────────────────────────────────────────────
async function tryOllama(prompt, maxTries, base) {
  console.log(`[LLM] Gemini rate-limited → falling back to Ollama (${OLLAMA_MODEL})...`);

  for (let t = 1; t <= maxTries; t++) {
    try {
      const result = await callOllama(prompt);
      console.log(`[LLM] ✓ Response via Ollama ${OLLAMA_MODEL}`);
      return result;
    } catch (err) {
      console.warn(`[LLM] ✗ Ollama attempt ${t}: ${err.message}`);

      if (isOllamaUnavailable(err)) {
        // Ollama not running or model not pulled — give clear instructions
        throw new Error(
          `Ollama is not available (${err.message}).\n` +
          `To enable the local fallback:\n` +
          `  1. Install Ollama: https://ollama.com\n` +
          `  2. Pull the model: ollama pull ${OLLAMA_MODEL}\n` +
          `  3. Ollama starts automatically — no extra steps needed.\n` +
          `Alternatively, wait for Gemini rate limit to reset (usually ~1 min).`
        );
      }

      if (t === maxTries) {
        throw new Error(`Ollama failed after ${maxTries} attempts. Last error: ${err.message}`);
      }

      const delay = Math.pow(2, t - 1) * base;
      console.warn(`[LLM] Retrying Ollama in ${delay}ms...`);
      await sleep(delay);
    }
  }
}

// ── Main export ────────────────────────────────────────────────────────────────
export async function generate(prompt, opts = {}) {
  const maxTries = opts.maxAttempts ?? 2;
  const base     = opts.baseDelayMs ?? 500;

  // ── Tier 1: Gemini 2.5 Flash ──────────────────────────────────────────────
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

  for (let t = 1; t <= maxTries; t++) {
    try {
      const result = await model.generateContent(prompt);
      return result; // native Gemini shape — callers do result.response.text()
    } catch (err) {
      if (isRateLimit(err)) {
        console.warn(`[LLM] Gemini 2.5 Flash rate-limited (attempt ${t}/${maxTries})`);
        if (t === maxTries) break; // fall through to Ollama
        const delay = Math.pow(2, t - 1) * base + Math.random() * 200;
        console.warn(`[LLM] Retrying Gemini in ${Math.round(delay)}ms...`);
        await sleep(delay);
        continue;
      }

      // Any other Gemini error — skip retries and go straight to Ollama
      console.warn(`[LLM] Gemini error (${err.message}) → trying Ollama`);
      break;
    }
  }

  // ── Tier 2: Ollama (local, no cost, no rate limits) ───────────────────────
  return tryOllama(prompt, maxTries, base);
}

export default { generate };