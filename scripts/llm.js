import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-2.5-flash' });

function isRetryableError(err) {
  try {
    const status = err?.response?.status || (err?.message && err.message.match(/\b(429|5\d{2})\b/)?.[0]);
    if (!status) return true; // network/unknown — be conservative
    const code = Number(status);
    return code === 429 || (code >= 500 && code < 600);
  } catch (e) { return true; }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export async function generate(prompt, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 400;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      return result;
    } catch (err) {
      if (attempt === maxAttempts || !isRetryableError(err)) throw err;
      const jitter = Math.floor(Math.random() * 200);
      const delay = Math.pow(2, attempt - 1) * baseDelayMs + jitter;
      console.warn(`LLM call failed (attempt ${attempt}) — retrying in ${delay}ms:`, err.message || err);
      await sleep(delay);
    }
  }
}

export default { generate };
