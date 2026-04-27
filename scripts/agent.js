/**
 * agent.js — QA Sentinel Smart Agent
 *
 * Exports:
 *   think()                  — single LLM call that reasons about user intent
 *   generateAllScenarioSteps() — batch plan generation (unchanged)
 *   fixSteps()               — surgical heal (unchanged)
 *   recordOutcome()          — write confirmed outcomes to learning memory
 *   getLearningExamples()    — read learning memory for prompt enrichment
 */

import fs   from 'fs';
import path from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { IDENTITY_ANCHOR } from './guard.js';
import { generate as llmGenerate } from './llm.js';
import dotenv from 'dotenv';
dotenv.config();

// ─────────────────────────────────────────────────────────────────────────────
// LEARNING MEMORY  (agent-memory.json)
//
// Structure:
// {
//   "appId": {
//     "examples": [
//       { "input": "test login", "intent": "EXECUTE", "scenarios": [...], "confirmedAt": "..." }
//     ],
//     "heals": [
//       { "from": "#create-btn", "to": "#submit-btn", "module": "projects", "succeededAt": "..." }
//     ],
//     "failures": [
//       { "module": "login", "scenario": "valid_login", "error": "...", "type": "FUNCTIONAL", "at": "..." }
//     ]
//   }
// }
// ─────────────────────────────────────────────────────────────────────────────

const AGENT_MEMORY_PATH = path.join(process.cwd(), 'agent-memory.json');
const MAX_EXAMPLES      = 12; // per app, keep most recent
const MAX_HEALS         = 20;
const MAX_FAILURES      = 10;

function loadAgentMemory() {
  try {
    if (fs.existsSync(AGENT_MEMORY_PATH)) {
      return JSON.parse(fs.readFileSync(AGENT_MEMORY_PATH, 'utf8'));
    }
  } catch {}
  return {};
}

function saveAgentMemory(mem) {
  fs.writeFileSync(AGENT_MEMORY_PATH, JSON.stringify(mem, null, 2), 'utf8');
}

function getAppSlot(mem, appId) {
  if (!mem[appId]) mem[appId] = { examples: [], heals: [], failures: [] };
  return mem[appId];
}

// Record a confirmed intent outcome (called after successful execution)
export function recordOutcome(appId, input, intent, scenarios = []) {
  const mem  = loadAgentMemory();
  const slot = getAppSlot(mem, appId);

  // Deduplicate — don't store the exact same input twice
  const exists = slot.examples.some(e => e.input.toLowerCase() === input.toLowerCase());
  if (!exists) {
    slot.examples.unshift({
      input,
      intent,
      scenarios: scenarios.map(s => ({ id: s.id, name: s.name, module: s.module })),
      confirmedAt: new Date().toISOString(),
    });
    slot.examples = slot.examples.slice(0, MAX_EXAMPLES);
  }
  saveAgentMemory(mem);
}

// Record a heal outcome (called after successful auto-heal)
export function recordHeal(appId, fromSelector, toSelector, module) {
  const mem  = loadAgentMemory();
  const slot = getAppSlot(mem, appId);
  slot.heals.unshift({ from: fromSelector, to: toSelector, module, succeededAt: new Date().toISOString() });
  slot.heals = slot.heals.slice(0, MAX_HEALS);
  saveAgentMemory(mem);
}

// Record a failure classification (called after classifyFailure)
export function recordFailure(appId, module, scenario, errorType, error) {
  const mem  = loadAgentMemory();
  const slot = getAppSlot(mem, appId);
  slot.failures.unshift({ module, scenario, errorType, error: error?.slice(0, 120), at: new Date().toISOString() });
  slot.failures = slot.failures.slice(0, MAX_FAILURES);
  saveAgentMemory(mem);
}

// Build few-shot examples string for think() prompt
export function getLearningExamples(appId) {
  const mem  = loadAgentMemory();
  const slot = mem[appId];
  if (!slot?.examples?.length) return '';

  const exs = slot.examples.slice(0, 6).map(e => {
    const scens = e.scenarios?.length
      ? `  scenarios: ${e.scenarios.map(s => `${s.module}/${s.id}`).join(', ')}`
      : '';
    return `  Input: "${e.input}"\n  Intent: ${e.intent}${scens ? '\n' + scens : ''}`;
  }).join('\n\n');

  return `## Past confirmed interactions (use as calibration)\n${exs}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// DOC UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

// Score docs by relevance to user input — return top 2 as compact summaries
function getRelevantDocSections(userInput, docs) {
  const terms = userInput.toLowerCase().split(/\s+/).filter(w => w.length > 2);

  const scored = docs.map(doc => {
    let score = 0;
    const lname    = doc.name.toLowerCase();
    const lcontent = doc.content.toLowerCase();

    // Module name match is a strong signal
    if (terms.some(t => lname.includes(t) || t.includes(lname))) score += 15;

    // Keyword hits in content
    terms.forEach(t => { if (lcontent.includes(t)) score += 1; });

    return { ...doc, score };
  }).filter(d => d.score > 0).sort((a, b) => b.score - a.score).slice(0, 2);

  if (!scored.length) {
    // No match — return just module names and scenario lists so the LLM knows what exists
    return docs.map(d => {
      const sec = d.content.match(/##\s*Test Scenarios\s*\n([\s\S]*?)(?=\n##|$)/i);
      const scenarios = sec
        ? sec[1].trim().split('\n').map(l => { const m = l.match(/[-*]\s*([a-z_]+):/i); return m ? m[1] : null; }).filter(Boolean)
        : [];
      return `Module: ${d.name} | Scenarios: ${scenarios.join(', ') || 'none'}`;
    }).join('\n');
  }

  return scored.map(doc => {
    // Extract only the relevant sections — URL, Description, Elements (brief), Test Scenarios
    const sections = [];

    const urlM  = doc.content.match(/##\s*URL\s*\n(https?:\/\/[^\s]+)/i);
    const descM = doc.content.match(/##\s*Description\s*\n([\s\S]*?)(?=\n##|$)/i);
    const scenM = doc.content.match(/##\s*Test Scenarios\s*\n([\s\S]*?)(?=\n##|$)/i);
    const elemM = doc.content.match(/##\s*Elements\s*\n([\s\S]*?)(?=\n##|$)/i);

    sections.push(`### Module: ${doc.name}`);
    if (urlM)  sections.push(`URL: ${urlM[1]}`);
    if (descM) sections.push(descM[1].trim().split('\n').slice(0, 2).join(' '));
    if (elemM) sections.push(`Key selectors:\n${elemM[1].trim().split('\n').slice(0, 8).join('\n')}`);
    if (scenM) sections.push(`Test scenarios:\n${scenM[1].trim()}`);

    return sections.join('\n');
  }).join('\n\n---\n\n');
}

// Build a compact summary of all available modules (for EXPLORE responses)
function buildModuleIndex(docs) {
  return docs.map(doc => {
    const sec = doc.content.match(/##\s*Test Scenarios\s*\n([\s\S]*?)(?=\n##|$)/i);
    const scenarios = sec
      ? sec[1].trim().split('\n')
          .map(l => { const m = l.match(/[-*]\s*([a-z_]+):\s*(.+)/i); return m ? `${m[1]}` : null; })
          .filter(Boolean)
      : [];
    return `- ${doc.name}: ${scenarios.join(', ') || 'no scenarios documented'}`;
  }).join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON EXTRACTION
// ─────────────────────────────────────────────────────────────────────────────

function extractJSON(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const match   = cleaned.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch {}
  }
  throw new Error('No valid JSON in response: ' + cleaned.slice(0, 200));
}

// ─────────────────────────────────────────────────────────────────────────────
// think()
//
// The single reasoning entry point. One LLM call. Returns structured decision.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string}  userInput
 * @param {object}  appContext  { id, name, baseUrl, docsDir, docs: Doc[] }
 * @param {object}  sessionCtx { lastRun, history: [{role,text}], appId }
 * @param {string?} liveDOM    optional live DOM snapshot
 *
 * @returns {Promise<{
 *   intent:               'EXECUTE'|'EXPLORE'|'DISCUSS'|'POST_RUN_Q'|'OUT_OF_SCOPE',
 *   confidence:           'high'|'low',
 *   response:             string | null,
 *   scenarios:            Array<{id,name,module,description}>,
 *   needs_clarification:  boolean,
 *   clarifying_question:  string | null,
 * }>}
 */
export async function think(userInput, appContext, sessionCtx = {}, liveDOM = null) {
  const { id: appId = 'default', name: appName, baseUrl, docs = [] } = appContext;
  const { lastRun = null, history = [] } = sessionCtx;

  // ── 1. Build compact context ──────────────────────────────────────────────
  const docSections   = getRelevantDocSections(userInput, docs);
  const moduleIndex   = buildModuleIndex(docs);
  const learnExamples = getLearningExamples(appId);

  // Last 5 turns only — format as alternating dialogue
  const recentHistory = history.slice(-5).map(t =>
    `  ${t.role === 'user' ? 'User' : 'Agent'}: ${t.text}`
  ).join('\n');

  // Last run summary — only what matters
  let lastRunSummary = '';
  if (lastRun) {
    const s = lastRun.summary || {};
    const failed = (lastRun.scenarios || []).filter(r => r.result?.status === 'failed');
    const healed = (lastRun.scenarios || []).filter(r => r.healCount > 0);
    const lines  = [`Last test run: ${s.total} total, ${s.passed} passed, ${s.failed} failed, ${s.healed} healed`];

    failed.forEach(r => {
      const fr = (r.result?.results || []).find(x => x.status === 'failed');
      if (fr) lines.push(`  ✗ ${r.scenario?.module}/${r.scenario?.name} failed at step ${r.result.results.indexOf(fr)+1}: ${fr.error?.slice(0,100)}`);
    });
    healed.forEach(r => {
      if (r.healMeta) lines.push(`  ⚙ Healed: ${r.healMeta.failedStep?.selector} → ${r.healMeta.fixedStep?.selector} in ${r.scenario?.module}`);
    });
    lastRunSummary = lines.join('\n');
  }

  // ── 2. Build the prompt ───────────────────────────────────────────────────
  const prompt = `${IDENTITY_ANCHOR}

You are a QA reasoning agent embedded in an enterprise test platform.
Your job is to understand what the user wants and return a structured decision — not a conversation.

## Active application
Name: ${appName}
Base URL: ${baseUrl}

## Available modules
${moduleIndex}

## Relevant documentation
${docSections}

${learnExamples ? learnExamples + '\n' : ''}${lastRunSummary ? '## Last test run\n' + lastRunSummary + '\n' : ''}${recentHistory ? '## Recent conversation\n' + recentHistory + '\n' : ''}${liveDOM ? '## Live browser DOM\n' + liveDOM.slice(0, 800) + '\n' : ''}
## User message
"${userInput}"

## Your task
Reason carefully about what the user wants.

Intent options:
- EXECUTE    → user wants to run one or more test scenarios right now
- EXPLORE    → user wants to know what can be tested, understand a module, or get scenario info
- DISCUSS    → user wants to build a custom test, discuss approach, or needs guidance
- POST_RUN_Q → user is asking about the last test run (failures, heals, results)
- OUT_OF_SCOPE → unrelated to QA testing

Rules:
- If the user names a module or action that maps to known scenarios → EXECUTE with high confidence
- If the intent is clear but no matching scenario exists → EXECUTE with low confidence + clarifying_question
- If EXECUTE, list ALL matching scenarios from the documentation (not just one)
- For EXPLORE/DISCUSS/POST_RUN_Q, write the response directly — it will be shown verbatim to the user
- Keep responses concise: 2-5 sentences or a short list. No paragraphs of prose.
- If confidence is low, ask ONE specific question that resolves the ambiguity
- If OUT_OF_SCOPE, response should be: "I only handle QA testing for ${appName}. Try: 'test login' or 'what can I test in the dashboard module?'"

## Required output format (return ONLY this JSON, nothing else):
{
  "intent": "EXECUTE",
  "confidence": "high",
  "response": null,
  "scenarios": [
    { "id": "valid_login", "name": "Valid login", "module": "login", "description": "Login with correct credentials and verify dashboard loads" }
  ],
  "needs_clarification": false,
  "clarifying_question": null
}`;

  // ── 3. Single LLM call ────────────────────────────────────────────────────
  try {
    const result = await llmGenerate(prompt, { maxAttempts: 1 });
    const text   = result.response.text();
    const parsed = extractJSON(text);

    // Validate and normalise the response
    const VALID_INTENTS = ['EXECUTE', 'EXPLORE', 'DISCUSS', 'POST_RUN_Q', 'OUT_OF_SCOPE'];
    if (!VALID_INTENTS.includes(parsed.intent)) parsed.intent = 'EXPLORE';
    if (!['high', 'low'].includes(parsed.confidence)) parsed.confidence = 'high';

    parsed.scenarios          = Array.isArray(parsed.scenarios) ? parsed.scenarios : [];
    parsed.needs_clarification = !!parsed.needs_clarification;
    parsed.clarifying_question = parsed.clarifying_question || null;
    parsed.response            = parsed.response || null;

    // If confidence is low but no clarifying question was set, generate one
    if (parsed.confidence === 'low' && !parsed.clarifying_question) {
      parsed.needs_clarification = true;
      parsed.clarifying_question = `Which specific scenario would you like to run? Available: ${
        docs.flatMap(d => {
          const sec = d.content.match(/##\s*Test Scenarios\s*\n([\s\S]*?)(?=\n##|$)/i);
          return sec ? sec[1].trim().split('\n').map(l => { const m = l.match(/[-*]\s*([a-z_]+)/i); return m ? m[1] : null; }).filter(Boolean) : [];
        }).slice(0, 6).join(', ')
      }`;
    }

    return parsed;

  } catch (err) {
    console.error('[think] LLM error:', err.message);
    // Deterministic fallback — never crash the agent
    return {
      intent:               'EXPLORE',
      confidence:           'low',
      response:             `I'm having trouble reasoning about that. Try: "test login", "what can I test in the dashboard?", or "why did the last test fail?"`,
      scenarios:            [],
      needs_clarification:  false,
      clarifying_question:  null,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PLAN GENERATION  (unchanged — server still uses these for execution)
// ─────────────────────────────────────────────────────────────────────────────

function systemPrompt() {
  try { return fs.readFileSync(path.join(process.cwd(), 'prompt.md'), 'utf-8'); } catch { return ''; }
}

function extractJSONFromText(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const obj = cleaned.match(/\{[\s\S]*\}/);
  if (obj) { try { return JSON.parse(obj[0]); } catch {} }
  const arr = cleaned.match(/\[[\s\S]*\]/);
  if (arr) { try { return JSON.parse(arr[0]); } catch {} }
  throw new Error('No valid JSON in model response:\n' + cleaned.slice(0, 300));
}

function build(...parts) {
  return parts.filter(Boolean).join('\n\n');
}

export async function generateSteps(userInput, docContext = '', browserContext = '') {
  const prompt = build(
    IDENTITY_ANCHOR,
    systemPrompt(),
    docContext     ? `## Relevant Documentation\n${docContext}` : null,
    browserContext ? `## Current Browser State\n${browserContext}` : null,
    `## User Request\n${userInput}\n\nGenerate test steps. Return ONLY valid JSON with module, scenario, and steps array.`
  );
  const result = await llmGenerate(prompt, { maxAttempts: 1 });
  const text   = result.response.text().replace(/```json|```/g, '').trim();
  return extractJSONFromText(text);
}

export async function generateAllScenarioSteps(scenarios, docContext = '', browserContext = '') {
  const scenarioList = scenarios
    .map((s, i) => `${i + 1}. id: "${s.id}" — ${s.name}: ${s.description || ''}`)
    .join('\n');

  const prompt = build(
    IDENTITY_ANCHOR,
    systemPrompt(),
    docContext     ? `## Relevant Documentation\n${docContext}` : null,
    browserContext ? `## Current Browser State\n${browserContext}` : null,
    `## Task
Generate test steps for ALL of the following scenarios in one response.

Scenarios:
${scenarioList}

Return a JSON array where each item has:
- id: the scenario id
- module: the feature module name (snake_case)
- scenario: the scenario id (snake_case)
- steps: array of Playwright test steps

Each step must have "action" and either "selector", "value", or both.
Supported actions: navigate, type, click, expect, expectUrl, waitForNavigation, wait, assertText

Return ONLY the JSON array, no explanation:
[{ "id": "...", "module": "...", "scenario": "...", "steps": [...] }]`
  );

  const result = await llmGenerate(prompt, { maxAttempts: 1 });
  const text   = result.response.text();

  try {
    const parsed = extractJSONFromText(text);
    return Array.isArray(parsed) ? parsed : (parsed.scenarios || []);
  } catch (err) {
    console.error('generateAllScenarioSteps parse error:', err.message);
    throw new Error('Could not parse batch scenario steps: ' + err.message);
  }
}

export async function fixSteps(originalPlan, error, userInput = '', liveContext = '') {
  const steps      = originalPlan.steps || [];
  const failedIdx  = steps.findIndex(s => s.selector && error.includes(s.selector));

  if (failedIdx >= 0) {
    return _fixSurgical(originalPlan, error, failedIdx, liveContext);
  }
  return _fixFullPlan(originalPlan, error, userInput, liveContext);
}

async function _fixSurgical(originalPlan, error, failedIndex, liveContext) {
  const steps       = originalPlan.steps || [];
  const failedStep  = steps[failedIndex];
  const stepsBefore = steps.slice(0, failedIndex);
  const stepsAfter  = steps.slice(failedIndex + 1);

  const prompt = build(
    IDENTITY_ANCHOR,
    systemPrompt(),
    liveContext ? `## Live DOM at failure\n${liveContext}` : null,
    `## Context
Scenario: ${originalPlan.module} / ${originalPlan.scenario}
Error: ${error}

## Broken step (step ${failedIndex + 1} of ${steps.length})
${JSON.stringify(failedStep, null, 2)}

## Steps BEFORE (all passed — do NOT change these)
${stepsBefore.map((s, i) => `  ${i + 1}. ${s.action} ${s.selector || s.value || ''}`).join('\n') || '  (none)'}

## Steps AFTER (preserve exactly — do NOT change these)
${stepsAfter.map((s, i) => `  ${failedIndex + 2 + i}. ${s.action} ${s.selector || s.value || ''}`).join('\n') || '  (none)'}

## Your task
Fix ONLY the broken step. Look at the Live DOM. Return ONE JSON object for the replacement step:
{ "action": "click", "selector": "#correct-id" }

Do NOT include surrounding steps.`
  );

  try {
    const result    = await llmGenerate(prompt, { maxAttempts: 1 });
    const text      = result.response.text().replace(/```json|```/g, '').trim();
    const fixedStep = extractJSONFromText(text);

    if (!fixedStep.action) throw new Error('Invalid step returned');

    return {
      ...originalPlan,
      steps: [...stepsBefore, fixedStep, ...stepsAfter],
      _healedIndex:  failedIndex,
      _originalStep: failedStep,
      _fixedStep:    fixedStep,
    };
  } catch (err) {
    console.warn('[fixSteps] Surgical fix failed, falling back:', err.message);
    return _fixFullPlan(originalPlan, error, '', liveContext);
  }
}

async function _fixFullPlan(originalPlan, error, userInput, liveContext) {
  const steps = originalPlan.steps || [];
  const prompt = build(
    IDENTITY_ANCHOR,
    systemPrompt(),
    liveContext ? `## Live DOM at failure\n${liveContext}` : null,
    `## Failed Plan\n${JSON.stringify(originalPlan, null, 2)}`,
    `## Error\n${error}`,
    userInput ? `## Original Intent\n${userInput}` : null,
    `## Instructions
Fix ONLY the broken step(s). Preserve ALL ${steps.length} steps.
Do not remove any step. Return the complete corrected plan as valid JSON.
CRITICAL: The output must have exactly ${steps.length} steps.`
  );

  const result = await llmGenerate(prompt, { maxAttempts: 1 });
  const text   = result.response.text().replace(/```json|```/g, '').trim();
  return extractJSONFromText(text);
}