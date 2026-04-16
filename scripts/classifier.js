import { generate as llmGenerate } from './llm.js';
import { IDENTITY_ANCHOR } from './guard.js';
import dotenv from 'dotenv';
dotenv.config();

// ── INTENT TYPES ──────────────────────────────────────────────────────────────
export const INTENT = {
  EXPLORE:       'EXPLORE',       // "what can I test here?"
  UNDERSTAND:    'UNDERSTAND',    // "how does this feature work?"
  PLAN:          'PLAN',          // "what scenarios should I cover?"
  EXECUTE:       'EXECUTE',       // "run the test", "test login"
  DEBUG:         'DEBUG',         // "why did that fail?"
  OUT_OF_SCOPE:  'OUT_OF_SCOPE',  // anything unrelated to QA
};

// ── AGENT STATES ──────────────────────────────────────────────────────────────
export const STATE = {
  IDLE:              'IDLE',
  GATHERING_CONTEXT: 'GATHERING_CONTEXT',
  PLANNING:          'PLANNING',
  EXECUTING:         'EXECUTING',
};

// ── CLASSIFIER ────────────────────────────────────────────────────────────────
export async function classifyIntent(userInput) {
  // Fast path — obvious execute patterns, skip LLM call
  const executePatterns = [
    /^test (the |my |)?(login|dashboard|projects?|profile|signup|checkout)/i,
    /^run (the |a |)?(test|scenario|automation)/i,
    /^(verify|check|validate) (the |that |)?(login|form|page|button|nav)/i,
    /with (valid|invalid|empty|wrong|correct)/i,
    /test.*scenario/i,
    /^(test|run|verify|check|validate|execute|start|do)\b/i, // Action starts
    /login|dashboard|signup|checkout|project/i
  ];

  for (const p of executePatterns) {
    if (p.test(userInput.trim())) {
      return { intent: INTENT.EXECUTE, confidence: 'high', reason: 'pattern match' };
    }
  }

  // Fast path — obvious out of scope
  const oosPatterns = [
    /^(hi|hello|hey|what'?s up|how are you)/i,
    /write (me )?(a |an )?(poem|story|essay|song)/i,
    /what is (the meaning|life|love)/i,
    /tell me (a |)joke/i,
    /cook|recipe|weather|news|sports/i,
  ];

  for (const p of oosPatterns) {
    if (p.test(userInput.trim())) {
      return { intent: INTENT.OUT_OF_SCOPE, confidence: 'high', reason: 'pattern match' };
    }
  }

  // LLM classification for ambiguous inputs
  const prompt = `${IDENTITY_ANCHOR}

## Task
Classify the user's intent into exactly one category.

Categories:
- EXPLORE: user wants to know what they can test ("what can I test?", "show me test options")
- UNDERSTAND: user wants to understand a feature ("how does login work?", "explain the flow")
- PLAN: user wants test scenarios listed but not run yet ("what scenarios should I cover?")
- EXECUTE: user wants to actually run a test ("test login", "run the invalid password test")
- DEBUG: user is asking about a past failure ("why did that fail?", "what went wrong?")
- OUT_OF_SCOPE: unrelated to QA testing

User input: "${userInput}"

Return ONLY this JSON:
{ "intent": "EXECUTE", "confidence": "high", "reason": "one sentence" }

No preamble. No markdown.`;

  try {
    const result = await llmGenerate(prompt);
    const text = (await result.response.text()).replace(/```json|```/g, '').trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
  } catch {
    // fallback — assume execute for QA-sounding input
  }

  return { intent: INTENT.EXECUTE, confidence: 'low', reason: 'fallback' };
}

// ── REDIRECT MESSAGE for out of scope ─────────────────────────────────────────
export function outOfScopeResponse(userInput) {
  return `I am a QA automation agent — I can only help with testing web applications. Try something like:\n• "test the login flow"\n• "what scenarios should I cover for the dashboard?"\n• "run the invalid password test"`;
}