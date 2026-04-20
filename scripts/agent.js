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
  // strip markdown fences
  text = text.replace(/```json|```/g, '').trim();
  // try object
  const obj = text.match(/\{[\s\S]*\}/);
  if (obj) { try { return JSON.parse(obj[0]); } catch {} }
  // try array
  const arr = text.match(/\[[\s\S]*\]/);
  if (arr) { try { return JSON.parse(arr[0]); } catch {} }
  throw new Error('No valid JSON in model response:\n' + text.slice(0, 300));
}

function build(...parts) {
  return parts.filter(Boolean).join('\n\n');
}

// ── MERGED CALL 1 ─────────────────────────────────────────────────────────────
// Replaces: classifyIntent() + checkReadiness() + identifyScenarios()
// One LLM call that returns everything the server needs to decide what to do next.
//
// Returns:
// {
//   intent: "EXECUTE" | "EXPLORE" | "UNDERSTAND" | "PLAN" | "DEBUG" | "OUT_OF_SCOPE"
//   ready: true | false
//   clarifying_question: null | "string"
//   scenarios: [ { id, name, description } ] | null
// }

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
    // Safe fallback — assume execute, ready, no scenarios
    console.error('analyzeRequest parse error:', err.message);
    return { intent: 'EXECUTE', ready: true, clarifying_question: null, scenarios: null };
  }
}

// ── MERGED CALL 2 ─────────────────────────────────────────────────────────────
// Replaces: N × generateStepsForScenario()
// One LLM call that generates steps for ALL selected scenarios at once.
//
// Returns:
// [
//   { id: "valid_login",      module: "login", scenario: "valid_login",      steps: [...] },
//   { id: "invalid_password", module: "login", scenario: "invalid_password", steps: [...] },
// ]

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

// ── Single scenario steps (fallback / specific requests) ─────────────────────
// Used when the user asks for one specific scenario directly.

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

// ── Auto-heal ─────────────────────────────────────────────────────────────────

export async function fixSteps(originalPlan, error, userInput = '', browserContext = '') {
  const prompt = build(
    IDENTITY_ANCHOR,
    systemPrompt(),
    browserContext ? `## Current Browser State\n${browserContext}` : null,
    `## Failed Plan\n${JSON.stringify(originalPlan, null, 2)}`,
    `## Error\n${error}`,
    userInput ? `## Original Intent\n${userInput}` : null,
    `Fix the steps so the test passes. Return ONLY valid JSON in the same format.`
  );

  const result = await llmGenerate(prompt, { maxAttempts: 1 });
  const text = result.response.text().replace(/```json|```/g, '').trim();
  return extractJSON(text);
}