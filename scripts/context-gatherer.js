import { generate as llmGenerate } from './llm.js';
import { IDENTITY_ANCHOR } from './guard.js';
import { getRelevantContext } from './context.js';
import { captureBrowserContext } from './browser-context.js';
import dotenv from 'dotenv';
dotenv.config();

// ── READINESS CHECK ───────────────────────────────────────────────────────────
// Asks the LLM: given what I know, can I generate a solid test plan?
// Returns { ready: bool, missingInfo: string|null }

async function checkReadiness(userInput, docContext, browserContext, conversationSoFar) {
  const prompt = `${IDENTITY_ANCHOR}

## What I know so far
User request: "${userInput}"
${conversationSoFar.length > 0 ? `Prior clarifications:\n${conversationSoFar.map(c => `- Q: ${c.question}\n  A: ${c.answer}`).join('\n')}` : ''}
${docContext ? `\nDocumentation available:\n${docContext}` : ''}
${browserContext ? `\nBrowser DOM state:\n${browserContext}` : ''}

## Task
You are about to generate a test plan.
Do you have enough information to generate accurate, specific test steps?

Ask yourself:
- Do I know which page/URL to test?
- Do I know what selectors or elements are involved?
- Do I know what the expected outcome is?
- Is there any ambiguity that would cause me to guess?

If documentation AND browser context are available, that is usually enough.
Only ask a clarifying question if there is genuine ambiguity that would cause incorrect test steps.

Return ONLY this JSON:
{ "ready": true }
OR
{ "ready": false, "question": "One specific question to resolve the ambiguity" }

No preamble. No markdown.`;

  try {
    const result = await llmGenerate(prompt);
    const text = (await result.response.text()).replace(/```json|```/g, '').trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
  } catch {}

  // If readiness check fails, assume ready — don't block the flow
  return { ready: true };
}

// ── CONTEXT GATHERER ──────────────────────────────────────────────────────────
// Orchestrates the full context gathering loop.
// Returns enriched context when the agent is confident enough to plan.
//
// askUser: async (question: string) => string
//   — caller provides this so server.js controls the WebSocket interaction

export async function gatherContext(userInput, intent, askUser, onLog) {
  const log = onLog || (() => {});

  // ── Layer 1: Document context ────────────────────────────────────────────
  log('Loading document context...');
  const docContext = getRelevantContext(userInput);
  if (docContext) {
    log('Relevant docs found', 'success');
  } else {
    log('No matching docs', 'warn');
  }

  // ── Layer 2: Browser context ─────────────────────────────────────────────
  log('Capturing browser DOM state...');
  let browserContext = '';
  try {
    browserContext = await captureBrowserContext();
    log('Browser context ready', 'success');
  } catch (err) {
    log('Browser context failed: ' + err.message, 'warn');
  }

  // ── Layer 3: Clarifying loop ─────────────────────────────────────────────
  // Max 2 questions — don't interrogate the user
  const conversationSoFar = [];
  const MAX_QUESTIONS = 2;

  for (let i = 0; i < MAX_QUESTIONS; i++) {
    const readiness = await checkReadiness(
      userInput,
      docContext,
      browserContext,
      conversationSoFar
    );

    if (readiness.ready) {
      log('Context is sufficient — proceeding', 'success');
      break;
    }

    // Ask the user
    log('Asking clarifying question...');
    const answer = await askUser(readiness.question);
    conversationSoFar.push({ question: readiness.question, answer });
    log(`You: ${answer}`, 'user');
  }

  // ── Build enriched input ─────────────────────────────────────────────────
  let enrichedInput = userInput;
  if (conversationSoFar.length > 0) {
    const clarifications = conversationSoFar
      .map(c => `${c.question} → ${c.answer}`)
      .join('. ');
    enrichedInput = `${userInput}. Additional context: ${clarifications}`;
  }

  return {
    enrichedInput,
    docContext,
    browserContext,
    clarifications: conversationSoFar,
  };
}