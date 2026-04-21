import fs from 'fs';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { IDENTITY_ANCHOR } from './guard.js';
import dotenv from 'dotenv';
dotenv.config();
import { generate as llmGenerate } from './llm.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function systemPrompt() {
  return fs.readFileSync('./prompt.md', 'utf-8');
}

function extractJSON(text) {
  text = text.replace(/```json|```/g, '').trim();
  const obj = text.match(/\{[\s\S]*\}/);
  if (obj) { try { return JSON.parse(obj[0]); } catch {} }
  const arr = text.match(/\[[\s\S]*\]/);
  if (arr) { try { return JSON.parse(arr[0]); } catch {} }
  throw new Error('No valid JSON in model response:\n' + text.slice(0, 300));
}

function build(...parts) {
  return parts.filter(Boolean).join('\n\n');
}

// ── MERGED CALL 1 ─────────────────────────────────────────────────────────────
export async function analyzeRequest(userInput, docContext = '', browserContext = '') {
  const prompt = build(
    IDENTITY_ANCHOR,
    systemPrompt(),
    docContext     ? `## Relevant Documentation\n${docContext}`    : null,
    browserContext ? `## Current Browser State\n${browserContext}` : null,
    `## Task
Analyze this user request and return a single JSON object.

User request: "${userInput}"

Do ALL of the following in one response:

1. Classify intent:
   - EXECUTE: user wants to run a test
   - EXPLORE: user wants to know what they can test
   - UNDERSTAND: user wants to understand a feature
   - PLAN: user wants scenarios listed but not run yet
   - DEBUG: user asking about a past failure
   - OUT_OF_SCOPE: unrelated to QA

2. Check readiness:
   - Given the docs and DOM state provided, do you have enough to generate accurate test steps?
   - If NO, provide ONE specific clarifying question.

3. If intent is EXECUTE, PLAN, or EXPLORE — identify 2-5 test scenarios for this request.
   Each scenario needs: id (snake_case), name (short), description (one sentence).

Return ONLY this JSON structure, no preamble:
{
  "intent": "EXECUTE",
  "ready": true,
  "clarifying_question": null,
  "scenarios": [
    { "id": "valid_login", "name": "Valid credentials", "description": "Login with correct username and password — should reach dashboard" },
    { "id": "invalid_password", "name": "Invalid password", "description": "Login with wrong password — should show error message" }
  ]
}`
  );

  const result = await llmGenerate(prompt, { maxAttempts: 1 });
  const text = result.response.text();

  try {
    return extractJSON(text);
  } catch (err) {
    console.error('analyzeRequest parse error:', err.message);
    return { intent: 'EXECUTE', ready: true, clarifying_question: null, scenarios: null };
  }
}

// ── MERGED CALL 2 ─────────────────────────────────────────────────────────────
export async function generateAllScenarioSteps(scenarios, docContext = '', browserContext = '') {
  const scenarioList = scenarios
    .map((s, i) => `${i + 1}. id: "${s.id}" — ${s.name}: ${s.description}`)
    .join('\n');

  const prompt = build(
    IDENTITY_ANCHOR,
    systemPrompt(),
    docContext     ? `## Relevant Documentation\n${docContext}`    : null,
    browserContext ? `## Current Browser State\n${browserContext}` : null,
    `## Task
Generate test steps for ALL of the following scenarios in one response.

Scenarios:
${scenarioList}

Return a JSON array where each item has:
- id: the scenario id from above
- module: the feature module name (snake_case)
- scenario: the scenario id (snake_case)
- steps: array of test steps

Each step must have "action" and either "selector", "value", or both depending on action type.
Supported actions: navigate, type, click, expect, expectUrl, waitForNavigation, wait, assertText

Return ONLY the JSON array, no preamble:
[
  {
    "id": "valid_login",
    "module": "login",
    "scenario": "valid_login",
    "steps": [
      { "action": "navigate", "value": "http://localhost:4000/testapp" },
      { "action": "type", "selector": "#username", "value": "admin" }
    ]
  }
]`
  );

  const result = await llmGenerate(prompt, { maxAttempts: 1 });
  const text = result.response.text();

  try {
    const parsed = extractJSON(text);
    return Array.isArray(parsed) ? parsed : (parsed.scenarios || []);
  } catch (err) {
    console.error('generateAllScenarioSteps parse error:', err.message);
    throw new Error('Could not parse batch scenario steps: ' + err.message);
  }
}

// ── Single scenario steps ─────────────────────────────────────────────────────
export async function generateSteps(userInput, docContext = '', browserContext = '') {
  const prompt = build(
    IDENTITY_ANCHOR,
    systemPrompt(),
    docContext     ? `## Relevant Documentation\n${docContext}`    : null,
    browserContext ? `## Current Browser State\n${browserContext}` : null,
    `## User Request\n${userInput}\n\nGenerate test steps. Return ONLY valid JSON with module, scenario, and steps array.`
  );

  const result = await llmGenerate(prompt, { maxAttempts: 1 });
  const text = result.response.text().replace(/```json|```/g, '').trim();
  return extractJSON(text);
}

// ── SURGICAL HEAL — fixes ONLY the broken step(s), preserves all others ───────
//
// Strategy:
//   1. Take the full original plan (all N steps)
//   2. Tell the LLM: "here is ONE broken step at index X — give me a replacement"
//   3. Splice the replacement back into the original array
//   4. Steps before and after the failure are NEVER touched
//
// This prevents the LLM from dropping post-failure steps like `expect #success-msg`.

export async function fixSteps(originalPlan, error, userInput = '', liveContext = '') {
  const steps = originalPlan.steps || [];

  // Find which step(s) failed — look for the error pattern in the context
  // The failed step index is passed via liveContext or we detect from error string
  const failedIndexMatch = liveContext.match(/at step (\d+):/i);
  const failedIndex = failedIndexMatch
    ? parseInt(failedIndexMatch[1]) - 1   // 1-based in display, 0-based in array
    : steps.findIndex(s => s.selector && error.includes(s.selector));

  // If we can't pinpoint a single step, fall back to asking LLM to fix the whole plan
  // but with STRICT instruction to keep all steps except broken ones
  if (failedIndex < 0 || failedIndex >= steps.length) {
    return _fixFullPlan(originalPlan, error, userInput, liveContext);
  }

  const failedStep = steps[failedIndex];
  const stepsBefore = steps.slice(0, failedIndex);
  const stepsAfter  = steps.slice(failedIndex + 1);   // ← these are PRESERVED verbatim

  const prompt = build(
    IDENTITY_ANCHOR,
    systemPrompt(),
    liveContext ? `## Live DOM at point of failure\n${liveContext}` : null,
    `## Context
Original scenario: ${originalPlan.module} / ${originalPlan.scenario}
Error: ${error}
User intent: ${userInput || 'not provided'}

## The broken step (index ${failedIndex + 1} of ${steps.length})
${JSON.stringify(failedStep, null, 2)}

## Steps BEFORE this (all passed — do NOT change these):
${stepsBefore.map((s, i) => `  ${i + 1}. ${s.action} ${s.selector || s.value || ''}`).join('\n') || '  (none)'}

## Steps AFTER this (not yet executed — do NOT change these):
${stepsAfter.map((s, i) => `  ${failedIndex + 2 + i}. ${s.action} ${s.selector || s.value || ''}`).join('\n') || '  (none)'}

## Your task
Fix ONLY the broken step above. Look at the Live DOM to find the correct selector/value.
Return ONLY a JSON object for the single replacement step:
{ "action": "click", "selector": "#correct-selector" }

Rules:
- Return exactly one step object
- Use actual selectors from the Live DOM
- Match the same intent as the broken step (same action type if possible)
- Do NOT include the surrounding steps`
  );

  try {
    const result = await llmGenerate(prompt, { maxAttempts: 1 });
    const text = result.response.text().replace(/```json|```/g, '').trim();
    const fixedStep = extractJSON(text);

    // Validate it looks like a step
    if (!fixedStep.action) throw new Error('LLM returned invalid step object');

    // Splice: before + fixed + after (stepsAfter is UNTOUCHED)
    const repairedSteps = [...stepsBefore, fixedStep, ...stepsAfter];

    return {
      ...originalPlan,
      steps: repairedSteps,
      _healedIndex: failedIndex,
      _originalStep: failedStep,
      _fixedStep: fixedStep,
    };
  } catch (err) {
    console.warn('[Heal] Single-step fix failed, falling back to full plan fix:', err.message);
    return _fixFullPlan(originalPlan, error, userInput, liveContext);
  }
}

// ── Full plan fix (fallback) — with strict instruction to preserve post-failure steps ──
async function _fixFullPlan(originalPlan, error, userInput, liveContext) {
  const steps = originalPlan.steps || [];

  const prompt = build(
    IDENTITY_ANCHOR,
    systemPrompt(),
    liveContext ? `## Live DOM at point of failure\n${liveContext}` : null,
    `## Failed Plan\n${JSON.stringify(originalPlan, null, 2)}`,
    `## Error\n${error}`,
    userInput ? `## Original Intent\n${userInput}` : null,
    `## Instructions
Fix ONLY the broken step(s) — the ones that caused the error above.
You MUST preserve ALL ${steps.length} steps. Do not remove any step.
If a step needs its selector changed, change only the selector — keep the action and intent.
Return the complete corrected plan as valid JSON in the same format.

CRITICAL: The output must have exactly ${steps.length} steps unless a step genuinely needs to be split into two.`
  );

  const result = await llmGenerate(prompt, { maxAttempts: 1 });
  const text = result.response.text().replace(/```json|```/g, '').trim();
  return extractJSON(text);
}

// ── Post-run explanation — answers "why did it fail / how was it fixed" ────────
export async function explainHeal(originalStep, fixedStep, error, liveDomSnippet = '') {
  const prompt = `${IDENTITY_ANCHOR}

A test step failed and was auto-healed. Explain this briefly to a non-technical stakeholder.

Original (broken) step: ${JSON.stringify(originalStep)}
Fixed step: ${JSON.stringify(fixedStep)}
Error: ${error}
${liveDomSnippet ? `DOM context: ${liveDomSnippet.slice(0, 400)}` : ''}

Rules:
- 2-3 sentences MAX
- Plain English, no jargon
- Explain what was wrong and what changed
- Do NOT use bullet points
- End with one reassuring sentence about the fix being saved

Return only the explanation text.`;

  try {
    const result = await llmGenerate(prompt, { maxAttempts: 1 });
    return result.response.text().trim();
  } catch {
    return `The selector for "${originalStep.selector || originalStep.action}" had changed in the UI. The system found the correct element in the live page and updated the step to "${fixedStep.selector || fixedStep.action}". This fix has been saved so the test won't fail on this step again.`;
  }
}

// ── Answer a question about the last test run ─────────────────────────────────
export async function answerAboutLastRun(question, lastRunContext) {
  if (!lastRunContext) {
    return "I don't have any test run data in this session yet. Run a test first, then ask me about it.";
  }

  const { scenarios, summary, healMeta, type } = lastRunContext;

  const scenarioSummary = (scenarios || []).map(s => {
    const status = s.result?.status || 'unknown';
    const steps  = s.result?.results || [];
    const failed = steps.find(r => r.status === 'failed');
    return [
      `Scenario: ${s.scenario?.name} [${s.scenario?.module}] — ${status.toUpperCase()}`,
      failed ? `  Failed at: ${failed.step?.action} ${failed.step?.selector || failed.step?.value || ''} — ${failed.error || ''}` : '',
      s.healCount > 0 ? `  Healed: ${s.healMeta?.originalStep?.selector || ''} → ${s.healMeta?.fixedStep?.selector || ''}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  const prompt = `${IDENTITY_ANCHOR}

The user is asking a follow-up question about a recently completed test run.

## Test run summary
Type: ${type || 'single'}
Total: ${summary?.total || 0} | Passed: ${summary?.passed || 0} | Failed: ${summary?.failed || 0} | Healed: ${summary?.healed || 0}

## Scenario details
${scenarioSummary}

## User question
"${question}"

Rules:
- Answer directly and concisely (2-4 sentences)
- Focus on what they asked — don't repeat the whole report
- If they ask about a heal/fix, explain what changed and why in plain English
- If they ask about a failure, describe what went wrong at that step
- If they ask something not covered by this run data, say so clearly
- No bullet points unless listing multiple distinct items
- Speak as a QA expert, not a robot

Return only the answer text.`;

  try {
    const result = await llmGenerate(prompt, { maxAttempts: 1 });
    return result.response.text().trim();
  } catch {
    return "I had trouble analyzing the run data. Could you ask more specifically — e.g. 'why did step 9 fail?' or 'what did the heal change?'";
  }
}