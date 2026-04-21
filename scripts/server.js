import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { chromium } from 'playwright';
dotenv.config();

import { analyzeRequest, generateAllScenarioSteps, fixSteps, explainHeal, answerAboutLastRun } from './agent.js';
import { runSteps } from './executor.js';
import { validatePlan } from './validator.js';
import { saveToMemory, findSimilarPlan } from './memory.js';
import { getRelevantContext, extractBaseUrl, extractDocScenarios, loadAllDocs } from './context.js';
import { captureBrowserContext } from './browser-context.js';
import { guardCheck } from './guard.js';
import { STATE, outOfScopeResponse } from './classifier.js';
import { gatherContext } from './context-gatherer.js';
import { generate as llmGenerate } from './llm.js';
import { IDENTITY_ANCHOR } from './guard.js';
import { classifyFailure, HEAL_DECISION, DECISION_META } from './failure-classifier.js';
import fs from 'fs';

// ── Per-connection state — lightweight "last run" memory ─────────────────────
// Avoids full session persistence while enabling follow-up questions.
// Cleared on each new test run so answers are always about the latest run.
const connectionState = new WeakMap(); // ws → { lastRun, lastHealMeta }

function getState(ws) {
  if (!connectionState.has(ws)) connectionState.set(ws, { lastRun: null });
  return connectionState.get(ws);
}

// ── Write LLM-generated scenarios back to the module's .md doc ───────────────
function appendScenariesToDocs(moduleName, scenarios) {
  try {
    const docsDir = process.env.DOCS_DIR || './docs';
    const filePath = `${docsDir}/${moduleName}.md`;
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, 'utf-8');
    if (/##\s*Test Scenarios/i.test(content)) return;
    const scenarioLines = scenarios
      .map(s => `- ${s.id || s.scenario}: ${s.description || s.name}`)
      .join('\n');
    fs.appendFileSync(filePath, `\n## Test Scenarios\n${scenarioLines}\n`, 'utf-8');
    console.log(`[Docs] Wrote ${scenarios.length} scenarios to ${filePath}`);
  } catch (err) {
    console.warn(`[Docs] Could not update ${moduleName}.md: ${err.message}`);
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "connect-src 'self' ws:",
    "script-src 'self' https://cdn.tailwindcss.com 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
  ].join('; '));
  next();
});

app.get('/.well-known/appspecific/com.chrome.devtools.json', (req, res) => res.json({ name: 'com.chrome.devtools', version: 1 }));
app.use(express.static(ROOT));
app.use('/testapp', express.static(path.join(ROOT, 'public', 'testapp')));
app.get('/testapp', (req, res) => res.sendFile(path.join(ROOT, 'public', 'testapp.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(ROOT, 'public', 'dashboard.html')));
app.get('/projects',  (req, res) => res.sendFile(path.join(ROOT, 'public', 'projects.html')));
app.get('/profile',   (req, res) => res.sendFile(path.join(ROOT, 'public', 'profile.html')));

// ── Core helpers ──────────────────────────────────────────────────────────────
function send(ws, type, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type, data }));
}
function log(ws, text, level = 'info') {
  if (!text?.trim()) return;
  console.log(`[${level.toUpperCase()}] ${text}`);
  send(ws, 'log', { text, level });
}
function sendState(ws, state) { send(ws, 'agent_state', state); }
function phase(ws, text) { send(ws, 'log', { text, level: 'phase' }); }

function waitForAnswer(ws, timeoutMs = 1800000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', handler); reject(new Error('Answer timeout')); }, timeoutMs);
    function handler(raw) {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'answer') { clearTimeout(timer); ws.off('message', handler); resolve(msg.data); }
      } catch {}
    }
    ws.on('message', handler);
  });
}

async function askUser(ws, question, questionType = 'text') {
  send(ws, 'question', { text: question, type: questionType });
  const answer = await waitForAnswer(ws);
  send(ws, 'answer_received', answer);
  return answer;
}

function injectDocUrl(plan, baseUrl) {
  if (!baseUrl || !plan?.steps) return plan;
  return {
    ...plan,
    steps: plan.steps.map(step => {
      if (step.action === 'navigate' && step.value && !step.value.startsWith('http')) {
        return { ...step, value: baseUrl + (step.value.startsWith('/') ? step.value : '/' + step.value) };
      }
      return step;
    }),
  };
}

// ── Live DOM capture from Playwright page at failure point ────────────────────
async function captureLiveDom(page) {
  try {
    const snapshot = await page.evaluate(() => {
      const SELECTORS = [
        'button','input','select','textarea',
        '[type="submit"]','[role="button"]','[role="link"]',
        'a[href]:not([href^="#"])',
        '[id]',
        'h1','h2','h3',
        '[data-testid]','[data-cy]','[data-qa]',
        '[aria-label]',
      ].join(',');
      const seen = new Set(), els = [];
      document.querySelectorAll(SELECTORS).forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        const key = (el.id ? `#${el.id}` : '') + el.tagName + (el.className||'').slice(0,20);
        if (seen.has(key)) return;
        seen.add(key);
        const e = {
          tag:        el.tagName.toLowerCase(),
          id:         el.id || null,
          type:       el.getAttribute('type') || null,
          name:       el.getAttribute('name') || null,
          role:       el.getAttribute('role') || null,
          ariaLabel:  el.getAttribute('aria-label') || null,
          dataTestid: el.getAttribute('data-testid') || el.getAttribute('data-cy') || null,
          placeholder:el.getAttribute('placeholder') || null,
          text:       el.innerText?.trim().slice(0, 60) || null,
          href:       el.getAttribute('href') || null,
        };
        Object.keys(e).forEach(k => e[k] === null && delete e[k]);
        els.push(e);
      });
      return { url: location.href, title: document.title, elements: els.slice(0, 80) };
    });
    const lines = [`URL: ${snapshot.url}`, `Title: ${snapshot.title}`, `Elements:`];
    for (const el of snapshot.elements) {
      const parts = [el.tag];
      if (el.id)          parts.push(`#${el.id}`);
      if (el.type)        parts.push(`[type=${el.type}]`);
      if (el.name)        parts.push(`[name=${el.name}]`);
      if (el.role)        parts.push(`[role=${el.role}]`);
      if (el.dataTestid)  parts.push(`[data-testid="${el.dataTestid}"]`);
      if (el.ariaLabel)   parts.push(`[aria-label="${el.ariaLabel}"]`);
      if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
      if (el.text)        parts.push(`text="${el.text}"`);
      if (el.href)        parts.push(`href="${el.href}"`);
      lines.push('  ' + parts.join(' '));
    }
    return lines.join('\n');
  } catch (err) {
    return `DOM capture failed: ${err.message}`;
  }
}

// ── Build rich heal context for LLM — includes failed step index for surgical heal ──
function buildHealContext(plan, result, failedStepResult, liveDom) {
  const failedIndex = failedStepResult ? (result.results || []).indexOf(failedStepResult) : -1;
  const passed = (result.results || [])
    .filter(r => r.status === 'success')
    .map((r, _, arr) => `  ✓ ${arr.indexOf(r) + 1}. ${r.step?.action} ${r.step?.selector || r.step?.value || ''}`);
  const failedLine = failedStepResult
    ? `  ✗ at step ${failedIndex + 1}: ${failedStepResult.step?.action} ${failedStepResult.step?.selector || failedStepResult.step?.value || ''}\n     ERROR: ${failedStepResult.error || result.error}`
    : `  ✗ ERROR: ${result.error}`;

  return [
    '## Live DOM at point of failure — use this to find correct selectors',
    liveDom || '(not captured)',
    '',
    '## Execution trace',
    ...passed,
    failedLine,
    '',
    '## Original plan steps',
    (plan.steps || []).map((s, i) => `  ${i + 1}. ${s.action} ${s.selector || s.value || ''}`).join('\n'),
    '',
    // Embed the failed step index so fixSteps() can do surgical repair
    `at step ${failedIndex + 1}: (${failedStepResult?.step?.action || ''} ${failedStepResult?.step?.selector || ''})`,
    '',
    '## Your task',
    `The selector "${failedStepResult?.step?.selector || result.error}" could not be found.`,
    'Look at the Live DOM above. Find the correct selector for the same element.',
    'Fix ONLY step ' + (failedIndex + 1) + '. All other steps are correct and must be preserved.',
    'Return the complete corrected plan as valid JSON.',
  ].join('\n');
}

function computePlanDiff(original, healed) {
  const changes = [], max = Math.max(original.length, healed.length);
  for (let i = 0; i < max; i++) {
    const o = original[i], h = healed[i];
    if (!o && h)  { changes.push({ type: 'added',   index: i, step: h }); continue; }
    if (o && !h)  { changes.push({ type: 'removed', index: i, step: o }); continue; }
    const ok = `${o.action}:${o.selector||''}:${o.value||''}`;
    const hk = `${h.action}:${h.selector||''}:${h.value||''}`;
    if (ok !== hk) changes.push({ type: 'changed', index: i, original: o, healed: h });
  }
  return { changes, originalLength: original.length, healedLength: healed.length };
}

// ── Emotional / conversational patterns ──────────────────────────────────────
const EMOTIONAL_PATTERNS = [
  /\b(new (to|here|in)|just joined|just started|onboard|first (day|week|time))\b/i,
  /\b(guide|help me understand|walk me through|show me|explain|teach me|how does|what should i|where do i start)\b/i,
  /\b(confused|lost|overwhelmed|don'?t know|not sure|unsure|clueless)\b/i,
  /\b(could you|can you|would you|please)\b.*\b(help|guide|explain|tell)\b/i,
  /\b(what (is|are|does)|how (do|does|can|should)|why (is|does))\b/i,
];

// ── POST-RUN QUESTION PATTERNS — detect follow-up about the last test ─────────
// These fire BEFORE generic intent detection so follow-ups always get context-aware answers.
const POST_RUN_PATTERNS = [
  /\b(why|what|how|explain|tell me).*(fail|broke|wrong|issue|problem|error|crash)\b/i,
  /\b(why|what|how).*(heal|fix|repair|auto.?heal|correct)\b/i,
  /\b(what (changed|was fixed|was wrong|happened))\b/i,
  /\b(what did (you|it|the system) (do|change|fix))\b/i,
  /\b(tell me (more|about) (the|that|this) (fail|error|issue|fix|heal))\b/i,
  /\b(how did (it|the test|this) (pass|work|succeed|get fixed))\b/i,
  /\b(what (selector|element|step) (changed|was wrong|broke))\b/i,
  /\b(previous (test|run|result))\b/i,
  /\b(last (test|run|result))\b/i,
  /\bwhy (did|was|is) (step|it|this|that)\b/i,
  /\b(root cause|cause of|reason for) (the |this )?(fail|error|issue)\b/i,
  /\b(summarize|details|break down) (the )?(failure|error|issue|test)\b/i,
];

function isPostRunQuestion(input, hasLastRun) {
  if (!hasLastRun) return false;
  return POST_RUN_PATTERNS.some(p => p.test(input));
}

// ── LLM-based intent detection ─────────────────────────────────────────────────
async function detectIntent(userInput, docScenarios, allDocs, hasLastRun) {
  const lower = userInput.toLowerCase().trim();

  // Post-run follow-up — highest priority when a run exists
  if (isPostRunQuestion(userInput, hasLastRun)) return 'POST_RUN_QUESTION';

  // Hard fast-paths
  if (/\bregression\b/i.test(lower)) return 'REGRESSION';

  const GREET = ['hi','hello','hey','help','good morning','good afternoon','good evening'];
  if (GREET.some(g => lower === g || lower.startsWith(g + ' '))) return 'GREET';
  if (EMOTIONAL_PATTERNS.some(p => p.test(lower))) return 'EMOTIONAL';

  if (/\b(list|show|what|which|tell me about|available|all)\b.*(module|scenario|test|can you test|available)\b/i.test(lower)) return 'EXPLORE';

  if (/^(test|run|execute|verify|check)\b/i.test(lower) && docScenarios.length > 0) return 'EXECUTE';

  // LLM for ambiguous
  const moduleList = allDocs.map(d => d.name).join(', ');
  const prompt = `${IDENTITY_ANCHOR}

User message: "${userInput}"
Available test modules: ${moduleList}
Has recent test run data: ${hasLastRun}

Classify this message into ONE of these intents:
- EXPLORE: user wants to know what can be tested, list modules, understand the app
- EXECUTE: user wants to run a test right now
- GREET: greeting or small talk
- EMOTIONAL: asking for guidance, onboarding, help understanding
- POST_RUN_QUESTION: asking about results, failures, or fixes from a recent test run

Return ONLY one word. Nothing else.`;

  try {
    const result = await llmGenerate(prompt, { maxAttempts: 1 });
    const text = result.response.text().trim().toUpperCase();
    if (['EXPLORE','EXECUTE','GREET','EMOTIONAL','POST_RUN_QUESTION'].includes(text)) return text;
  } catch {}

  return docScenarios.length > 0 ? 'EXECUTE' : 'EXPLORE';
}

const SYNONYMS = {
  correct: ['valid'], right: ['valid'], good: ['valid'],
  wrong: ['invalid'], bad: ['invalid'], incorrect: ['invalid'],
  blank: ['empty'],
};

function resolveSpecificScenario(input, docScenarios) {
  const promptWords = input.toLowerCase().split(/\s+/).filter(w => w.length > 1);
  const expanded = [...promptWords];
  promptWords.forEach(w => { if (SYNONYMS[w]) expanded.push(...SYNONYMS[w]); });
  const scored = docScenarios.map(s => {
    const raw = [...s.id.split('_'), ...s.name.toLowerCase().split(/\s+/)].filter(w => w.length > 2);
    const keywords = [...new Set(raw)];
    const matches = keywords.filter(kw => expanded.some(pw => pw === kw));
    return { scenario: s, score: matches.length };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  const top = scored[0], second = scored[1];
  return (!second || top.score > second.score) && top.score >= 2 ? top.scenario : null;
}

function buildExploreResponse(docScenarios, docs, userInput) {
  const lower = userInput.toLowerCase();
  const matchedDoc = docs.find(d => lower.includes(d.name.toLowerCase()));
  if (matchedDoc) {
    const scenarios = matchedDoc.content.match(/##\s*Test Scenarios\s*\n([\s\S]*?)(?=\n##|$)/i)?.[1]?.trim().split('\n')
      .map(line => { const m = line.match(/[-*]\s*([a-z_]+):\s*(.+)/i); return m ? { name: m[1].replace(/_/g,' '), description: m[2] } : null; })
      .filter(Boolean) || [];
    const urlMatch = matchedDoc.content.match(/##\s*URL\s*\n(https?:\/\/[^\s]+)/i);
    const desc = matchedDoc.content.match(/##\s*Description\s*\n([\s\S]*?)(?=\n##|$)/i)?.[1]?.trim();
    let msg = `**${matchedDoc.name}** module`;
    if (urlMatch) msg += ` — ${urlMatch[1]}`;
    msg += '\n';
    if (desc) msg += `${desc}\n\n`;
    if (scenarios.length > 0) {
      msg += `Scenarios:\n${scenarios.map((s, i) => `${i+1}. ${s.name} — ${s.description}`).join('\n')}`;
      msg += `\n\nSay "test ${matchedDoc.name}" to run all, or name a specific scenario.`;
    }
    return msg;
  }
  const modules = [...new Set(docs.map(d => d.name))];
  const scenarioCounts = docs.map(d => {
    const section = d.content.match(/##\s*Test Scenarios\s*\n([\s\S]*?)(?=\n##|$)/i);
    const count = section ? (section[1].match(/[-*]\s*[a-z_]+:/gi) || []).length : 0;
    return `• ${d.name} — ${count} scenario${count !== 1 ? 's' : ''}`;
  });
  return `${modules.length} testable modules:\n\n${scenarioCounts.join('\n')}\n\nSay "test [module]" to run, or ask about any module.`;
}

async function generateWarmResponse(userInput, allDocs) {
  const first = allDocs[0]?.name || 'login';
  const modules = allDocs.map(d => d.name).join(', ');
  const prompt = `${IDENTITY_ANCHOR}

You are a QA partner in a chat tool. Be extremely brief.
User said: "${userInput}"
Modules: ${modules}

RULES:
- 1-2 sentences MAX. No paragraphs, no lists.
- Acknowledge briefly, then give ONE concrete command they can type.
- Example: "Sure! Try \"test login\" to start, or \"run regression\" for everything."
- Never ask questions back. Never explain what you can do.`;

  try {
    const result = await llmGenerate(prompt, { maxAttempts: 1 });
    const text = result.response.text().trim().replace(/^["']|["']$/g, '');
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    return sentences.slice(0, 2).join(' ').trim().slice(0, 180);
  } catch {
    return `Sure! Try "test ${first}" to start, or "run regression" for the full suite.`;
  }
}

// ── Confirm execution ─────────────────────────────────────────────────────────
async function confirmExecution(ws, scenario, plan) {
  send(ws, 'plan', { ...plan, scenarioId: scenario.id });
  send(ws, 'question', {
    text: scenario.name,
    type: 'confirm_run',
    meta: { scenarioName: scenario.name, totalSteps: plan.steps.length },
  });
  const answer = await waitForAnswer(ws);
  return /yes|run|ok|confirm|go|start/i.test(answer);
}

// ── Execute one plan ──────────────────────────────────────────────────────────
async function executePlan(ws, plan, scenario, userInput, baseUrl, browser) {
  const finalPlan = injectDocUrl(plan, baseUrl);
  send(ws, 'plan', { ...finalPlan, scenarioId: scenario.id });
  sendState(ws, STATE.EXECUTING);
  phase(ws, '── Executing steps ──');

  let liveDomAtFailure = null;
  let liveUrlAtFailure = null;

  let result = await runSteps(finalPlan.steps, {
    browser, baseUrl,
    onStep: (index, step, status) => send(ws, 'step', { index, status }),
    onLog:  (text, level) => log(ws, text, level),
    onFail: async (page) => {
      try {
        liveUrlAtFailure = page.url();
        liveDomAtFailure = await captureLiveDom(page);
        log(ws, `Live DOM captured at: ${liveUrlAtFailure}`, 'info');
      } catch (e) {
        log(ws, `Live DOM capture failed: ${e.message}`, 'warn');
      }
    },
  });

  let healCount = 0;
  let healMeta = null;

  if (result.status === 'failed') {
    phase(ws, '── Analysing failure ──');

    const failedStepResult = (result.results || []).find(r => r.status === 'failed') || null;
    const failedIndex = failedStepResult ? result.results.indexOf(failedStepResult) : -1;

    const classification = classifyFailure(
      failedStepResult?.step,
      result.error,
      result.results
    );
    log(ws, `Failure type: ${classification.type} — ${classification.reason}`, 'warn');

    send(ws, 'failure_classified', {
      ...classification,
      canHeal:     DECISION_META[classification.decision].canHeal,
      error:       result.error,
      failedStep:  failedStepResult?.step ?? null,
      failedIndex,
      passedCount: (result.results || []).filter(r => r.status === 'success').length,
      totalSteps:  finalPlan.steps.length,
    });

    let healPreview = null;
    if (DECISION_META[classification.decision].canHeal) {
      if (!liveDomAtFailure) {
        try {
          liveDomAtFailure = await captureBrowserContext(liveUrlAtFailure || baseUrl);
        } catch {}
      }
      if (liveDomAtFailure) {
        const candidates = liveDomAtFailure.split('\n')
          .filter(l => /^\s+(button|input|\[type=submit\]|\[role=button\])/.test(l))
          .map(l => l.trim())
          .slice(0, 6);
        healPreview = {
          failedSelector:  failedStepResult?.step?.selector || '',
          liveUrl:         liveUrlAtFailure || baseUrl,
          candidates,
          domElementCount: liveDomAtFailure.split('\n').filter(l => l.startsWith('  ')).length,
        };
      }
    }

    send(ws, 'question', {
      text: result.error,
      type: 'heal_choice',
      meta: {
        classification,
        canHeal:    DECISION_META[classification.decision].canHeal,
        failedStep: failedStepResult?.step ?? null,
        failedIndex,
        error:      result.error,
        passedCount: (result.results || []).filter(r => r.status === 'success').length,
        totalSteps:  finalPlan.steps.length,
        healPreview,
      },
    });

    const choice = await waitForAnswer(ws);

    if (/yes|heal|try|fix|retry/i.test(choice) && DECISION_META[classification.decision].canHeal) {
      phase(ws, '── Auto-healing (surgical) ──');
      log(ws, 'Targeting broken step only — all other steps will be preserved...', 'info');

      // Build context with the "at step N:" marker so fixSteps() can do surgical repair
      const healContext = buildHealContext(finalPlan, result, failedStepResult, liveDomAtFailure);

      // fixSteps now returns a plan with ONLY the broken step replaced
      const fixedPlan   = await fixSteps(finalPlan, result.error, userInput, healContext);
      validatePlan(fixedPlan);

      // Verify step count — warn if LLM dropped steps despite instructions
      if (fixedPlan.steps.length < finalPlan.steps.length) {
        log(ws, `Warning: healed plan has fewer steps (${fixedPlan.steps.length} vs ${finalPlan.steps.length}). Restoring missing tail steps.`, 'warn');
        // Safety net: if LLM dropped tail steps, re-append from original
        const missing = finalPlan.steps.slice(fixedPlan.steps.length);
        fixedPlan.steps = [...fixedPlan.steps, ...missing];
      }

      const fixedWithUrl = injectDocUrl(fixedPlan, baseUrl);
      const diffData     = computePlanDiff(finalPlan.steps, fixedWithUrl.steps);
      send(ws, 'heal_diff', diffData);
      send(ws, 'plan', { ...fixedWithUrl, scenarioId: scenario.id });

      phase(ws, '── Retrying healed plan ──');

      liveDomAtFailure = null;
      liveUrlAtFailure = null;

      result = await runSteps(fixedWithUrl.steps, {
        browser, baseUrl,
        onStep: (i, s, st) => send(ws, 'step', { index: i, status: st }),
        onLog:  (t, l) => log(ws, t, l),
        onFail: async (page) => {
          try {
            liveUrlAtFailure = page.url();
            liveDomAtFailure = await captureLiveDom(page);
          } catch {}
        },
      });

      healCount++;

      if (result.status === 'success') {
        log(ws, 'Heal succeeded ✓', 'success');
        saveToMemory(fixedPlan);
        log(ws, `Updated memory: "${fixedPlan.module}__${fixedPlan.scenario}"`, 'success');

        healMeta = {
          originalError: failedStepResult?.error || result.error,
          failedStep:    failedStepResult?.step ?? null,
          failedIndex,
          fixedStep:     fixedPlan._fixedStep ?? fixedPlan.steps[failedIndex] ?? null,
          diff:          diffData,
          classification,
        };

        // Generate and send a plain-English explanation for stakeholders
        const explanation = await explainHeal(
          failedStepResult?.step ?? {},
          fixedPlan._fixedStep ?? fixedPlan.steps[failedIndex] ?? {},
          result.error || failedStepResult?.error || '',
          liveDomAtFailure?.slice(0, 600) || ''
        );
        log(ws, `Heal explanation: ${explanation}`, 'info');
        // Store for post-run Q&A
        healMeta._explanation = explanation;

      } else {
        log(ws, 'Heal also failed — likely a real application bug.', 'error');
        send(ws, 'heal_failed', { error: result.error, attempts: 1, classification });
      }
    } else {
      log(ws, 'Stopped by user.', 'warn');
    }

    result._classification = classification;

  } else {
    phase(ws, '── Saving to memory ──');
    saveToMemory(finalPlan);
    log(ws, `Cached: "${finalPlan.module}__${finalPlan.scenario}"`, 'success');
  }

  return { result, healCount, healMeta };
}

// ── Shared scenario runner ────────────────────────────────────────────────────
async function runScenarios(ws, toRun, getPlan, userInput, baseUrl, browserInstance, confirmEach = true) {
  const scenarioResults = [];
  let totalHealed = 0;

  for (let i = 0; i < toRun.length; i++) {
    const s = toRun[i];
    const plan = typeof getPlan === 'function'
      ? getPlan(s)
      : getPlan.find(r => r.scenario.id === s.id)?.cached;

    if (!plan) {
      log(ws, `No plan for "${s.name}" — skipping`, 'warn');
      scenarioResults.push({ scenario: s, result: { status: 'skipped', results: [] }, healCount: 0, healMeta: null });
      continue;
    }

    phase(ws, `── Scenario ${i+1}/${toRun.length}: ${s.name} ──`);
    log(ws, s.description, 'info');
    send(ws, 'scenario_start', s);

    if (confirmEach) {
      const confirmed = await confirmExecution(ws, s, plan);
      if (!confirmed) {
        log(ws, `Skipped: ${s.name}`, 'warn');
        scenarioResults.push({ scenario: s, result: { status: 'skipped', results: [] }, healCount: 0 });
        continue;
      }
    }

    const { result, healCount, healMeta } = await executePlan(ws, plan, s, userInput, baseUrl, browserInstance);
    scenarioResults.push({ scenario: s, result, healCount, healMeta });
    totalHealed += healCount;

    if (i < toRun.length - 1) await new Promise(r => setTimeout(r, 400));
  }

  return { scenarioResults, totalHealed };
}

// ── MAIN ORCHESTRATION ────────────────────────────────────────────────────────
async function orchestrate(ws, userInput) {
  let browserInstance = null;
  const state = getState(ws);

  try {
    const guard = guardCheck(userInput);
    if (!guard.safe) { send(ws, 'agent_message', guard.reason); return; }

    sendState(ws, STATE.GATHERING_CONTEXT);

    const docContext   = getRelevantContext(userInput);
    const baseUrl      = extractBaseUrl(userInput) || process.env.BASE_URL || 'http://localhost:4000/testapp';
    const docScenarios = extractDocScenarios(userInput);
    const allDocs      = loadAllDocs();
    const module       = docScenarios[0]?.module || 'general';

    // ── LLM-based intent detection ──────────────────────────────────────────
    const intent = await detectIntent(userInput, docScenarios, allDocs, !!state.lastRun);
    log(ws, `Intent: ${intent}`, 'info');

    // ── POST-RUN QUESTION — answer using last run context ───────────────────
    if (intent === 'POST_RUN_QUESTION') {
      const answer = await answerAboutLastRun(userInput, state.lastRun);
      send(ws, 'agent_message', answer);
      sendState(ws, STATE.IDLE);
      return;
    }

    // ── GREET ───────────────────────────────────────────────────────────────
    if (intent === 'GREET') {
      const modules = [...new Set(allDocs.map(d => d.name))];
      send(ws, 'agent_message', `Hi! I'm your QA partner.\n\nTestable modules:\n${modules.map(m => `• ${m}`).join('\n')}\n\nTry "test login", "run regression", or ask about any module.`);
      sendState(ws, STATE.IDLE);
      return;
    }

    // ── EMOTIONAL ───────────────────────────────────────────────────────────
    if (intent === 'EMOTIONAL') {
      const reply = await generateWarmResponse(userInput, allDocs);
      send(ws, 'agent_message', reply);
      sendState(ws, STATE.IDLE);
      return;
    }

    // ── EXPLORE ─────────────────────────────────────────────────────────────
    if (intent === 'EXPLORE') {
      send(ws, 'agent_message', buildExploreResponse(docScenarios, allDocs, userInput));
      sendState(ws, STATE.IDLE);
      return;
    }

    // From here on, a test run will happen — clear last run state
    state.lastRun = null;
    phase(ws, '── Loading context ──');
    if (docContext) log(ws, `Docs loaded: ${module}`, 'success');
    else log(ws, 'No matching docs found', 'warn');

    // ── REGRESSION ──────────────────────────────────────────────────────────
    if (intent === 'REGRESSION') {
      phase(ws, '── Regression Test Suite ──');
      log(ws, 'Loading all modules...', 'info');
      const allScenarios = [];
      for (const doc of allDocs) {
        const section = doc.content.match(/##\s*Test Scenarios\s*\n([\s\S]*?)(?=\n##|$)/i);
        if (!section) continue;
        section[1].trim().split('\n').forEach(line => {
          const m = line.match(/[-*]\s*([a-z_]+):\s*(.+)/i);
          if (m) allScenarios.push({ id: m[1].trim().toLowerCase(), name: m[1].trim().replace(/_/g,' '), description: m[2].trim(), module: doc.name });
        });
      }
      log(ws, `Found ${allScenarios.length} scenarios across ${allDocs.length} modules`, 'info');
      const memoryCheck = allScenarios.map(s => ({ scenario: s, cached: findSimilarPlan(s.module, s.id) }));
      const uncached = memoryCheck.filter(r => !r.cached).map(r => r.scenario);
      const cachedCount = memoryCheck.length - uncached.length;
      log(ws, `${cachedCount} of ${allScenarios.length} plans cached`, cachedCount === allScenarios.length ? 'success' : 'info');
      if (uncached.length > 0) {
        phase(ws, '── Generating missing plans ──');
        const browserCtx = await captureBrowserContext(baseUrl);
        const byModule = {};
        uncached.forEach(s => { (byModule[s.module] = byModule[s.module] || []).push(s); });
        for (const [mod, scenarios] of Object.entries(byModule)) {
          log(ws, `Generating ${scenarios.length} plans for ${mod}...`, 'info');
          const batch = await generateAllScenarioSteps(scenarios, getRelevantContext(mod), browserCtx);
          batch.forEach(p => {
            validatePlan(p); saveToMemory(p);
            const m = memoryCheck.find(r => r.scenario.id === p.id && r.scenario.module === p.module);
            if (m) m.cached = p;
            log(ws, `Saved: ${p.module}__${p.scenario}`, 'success');
          });
          appendScenariesToDocs(mod, scenarios);
        }
      }
      send(ws, 'regression_plan', {
        modules: allDocs.map(d => ({ name: d.name, scenarios: allScenarios.filter(s => s.module === d.name) })),
        total: allScenarios.length,
      });
      const choice = await waitForAnswer(ws);
      if (!/yes|run|ok|confirm|go|start|all/i.test(choice)) {
        send(ws, 'agent_message', 'Regression cancelled. Let me know when you\'re ready.');
        sendState(ws, STATE.IDLE);
        return;
      }
      sendState(ws, STATE.EXECUTING);
      browserInstance = await chromium.launch({ headless: false });
      const { scenarioResults, totalHealed } = await runScenarios(ws, allScenarios, (s) => memoryCheck.find(r => r.scenario.id === s.id && r.scenario.module === s.module)?.cached, userInput, baseUrl, browserInstance, false);
      const passed = scenarioResults.filter(r => r.result.status === 'success' && !r.healCount).length;
      const failed = scenarioResults.filter(r => r.result.status === 'failed').length;
      const skipped = scenarioResults.filter(r => r.result.status === 'skipped').length;
      const reportData = { type: 'regression', status: failed === 0 ? 'success' : 'failed', healCount: totalHealed, scenarios: scenarioResults, summary: { total: scenarioResults.length, passed, failed, skipped, healed: totalHealed } };
      send(ws, 'report', reportData);
      // Save for post-run Q&A
      state.lastRun = reportData;
      sendState(ws, STATE.IDLE);
      return;
    }

    // ── EXECUTE — specific scenario first, then module ───────────────────────
    if (intent === 'EXECUTE') {
      const specific = resolveSpecificScenario(userInput.toLowerCase(), docScenarios);

      if (specific) {
        log(ws, `Matched: "${specific.name}"`, 'success');
        send(ws, 'scenario_start', specific);
        const cached = findSimilarPlan(specific.module, specific.id, userInput);
        let plan = cached;
        if (!cached) {
          log(ws, 'Cache miss — generating via LLM', 'info');
          const browserCtx = await captureBrowserContext(baseUrl);
          const batch = await generateAllScenarioSteps([specific], docContext, browserCtx);
          plan = batch[0];
          validatePlan(plan);
          saveToMemory(plan);
        } else {
          log(ws, `Memory hit — ${cached.steps?.length} steps`, 'success');
        }
        const confirmed = await confirmExecution(ws, specific, plan);
        if (!confirmed) { send(ws, 'agent_message', 'No problem — let me know when you\'re ready.'); sendState(ws, STATE.IDLE); return; }
        browserInstance = await chromium.launch({ headless: false });
        const { result, healCount, healMeta } = await executePlan(ws, plan, specific, userInput, baseUrl, browserInstance);
        const reportData = { status: result.status, healCount, scenarios: [{ scenario: specific, result, healCount, healMeta }], summary: { total: 1, passed: (result.status === 'success' && !healCount) ? 1 : 0, failed: result.status === 'failed' ? 1 : 0, skipped: 0, healed: healCount } };
        send(ws, 'report', reportData);
        // Save for post-run Q&A
        state.lastRun = reportData;
        sendState(ws, STATE.IDLE);
        return;
      }

      if (docScenarios.length > 0) {
        const memoryCheck = docScenarios.map(s => ({ scenario: s, cached: findSimilarPlan(module, s.id, userInput) }));
        const cachedCount = memoryCheck.filter(r => r.cached).length;
        log(ws, `${cachedCount} of ${docScenarios.length} scenarios cached`, cachedCount === docScenarios.length ? 'success' : 'info');
        const uncached = memoryCheck.filter(r => !r.cached).map(r => r.scenario);
        if (uncached.length > 0) {
          const browserCtx = await captureBrowserContext(baseUrl);
          const batch = await generateAllScenarioSteps(uncached, docContext, browserCtx);
          batch.forEach(p => { validatePlan(p); saveToMemory(p); const m = memoryCheck.find(r => r.scenario.id === p.id); if (m) m.cached = p; });
          appendScenariesToDocs(module, uncached);
        }
        sendState(ws, STATE.PLANNING);
        send(ws, 'scenarios', { scenarios: docScenarios, module: docScenarios[0]?.module || userInput });
        const choice = await waitForAnswer(ws);
        send(ws, 'answer_received', choice);
        const toRun = choice.toLowerCase().includes('all') ? docScenarios : (() => {
          const indices = [...choice.matchAll(/\d+/g)].map(m => parseInt(m[0]) - 1);
          return indices.length > 0 ? indices.filter(i => i >= 0 && i < docScenarios.length).map(i => docScenarios[i]) : docScenarios;
        })();
        sendState(ws, STATE.EXECUTING);
        browserInstance = await chromium.launch({ headless: false });
        const { scenarioResults, totalHealed } = await runScenarios(ws, toRun, memoryCheck, userInput, baseUrl, browserInstance, true);
        const passed = scenarioResults.filter(r => r.result.status === 'success' && !r.healCount).length;
        const failed = scenarioResults.filter(r => r.result.status === 'failed').length;
        const skipped = scenarioResults.filter(r => r.result.status === 'skipped').length;
        const reportData = { status: failed === 0 ? 'success' : 'failed', healCount: totalHealed, scenarios: scenarioResults, summary: { total: scenarioResults.length, passed, failed, skipped, healed: totalHealed } };
        send(ws, 'report', reportData);
        state.lastRun = reportData;
        sendState(ws, STATE.IDLE);
        return;
      }
    }

    // ── LLM analysis for truly ambiguous inputs ──────────────────────────────
    phase(ws, '── Analyzing request ──');
    const browserCtx = await captureBrowserContext(baseUrl);
    const { enrichedInput } = await gatherContext(userInput, null, (q) => askUser(ws, q), (t, l) => log(ws, t, l));
    const analysis = await analyzeRequest(enrichedInput, docContext, browserCtx);
    if (analysis.intent === 'OUT_OF_SCOPE') { send(ws, 'agent_message', outOfScopeResponse(userInput)); return; }
    if (analysis.intent === 'EXPLORE' || analysis.intent === 'UNDERSTAND') { send(ws, 'agent_message', buildExploreResponse(docScenarios, allDocs, userInput)); return; }
    const scenarios = docScenarios.length > 0 ? docScenarios : (analysis.scenarios || []);
    if (!scenarios.length) { send(ws, 'agent_message', 'Could not identify test scenarios. Try: "test login", "test projects", or "run regression".'); return; }
    sendState(ws, STATE.PLANNING);
    const planMap = {};
    const stillUncached = scenarios.filter(s => { const p = findSimilarPlan(module, s.id); if (p) { planMap[s.id] = p; return false; } return true; });
    if (stillUncached.length > 0) {
      const batch = await generateAllScenarioSteps(stillUncached, docContext, browserCtx);
      batch.forEach(p => { validatePlan(p); saveToMemory(p); planMap[p.id] = p; });
    }
    send(ws, 'scenarios', { scenarios, module: scenarios[0]?.module || userInput });
    const choice2 = await waitForAnswer(ws);
    const finalToRun = choice2.toLowerCase().includes('all') ? scenarios : (() => {
      const indices = [...choice2.matchAll(/\d+/g)].map(m => parseInt(m[0]) - 1);
      return indices.length > 0 ? indices.filter(i => i >= 0 && i < scenarios.length).map(i => scenarios[i]) : scenarios;
    })();
    sendState(ws, STATE.EXECUTING);
    browserInstance = await chromium.launch({ headless: false });
    const { scenarioResults: rr, totalHealed: rh } = await runScenarios(ws, finalToRun, (s) => planMap[s.id], enrichedInput, baseUrl, browserInstance, true);
    const rp = rr.filter(r => r.result.status === 'success').length;
    const rf = rr.filter(r => r.result.status === 'failed').length;
    const rs = rr.filter(r => r.result.status === 'skipped').length;
    const reportData = { status: rf === 0 ? 'success' : 'failed', healCount: rh, scenarios: rr, summary: { total: rr.length, passed: rp, failed: rf, skipped: rs, healed: rh } };
    send(ws, 'report', reportData);
    state.lastRun = reportData;
    sendState(ws, STATE.IDLE);

  } catch (err) {
    phase(ws, '── Error ──');
    log(ws, err.message, 'error');
    send(ws, 'error', err.message);
    sendState(ws, STATE.IDLE);
  } finally {
    if (browserInstance) await browserInstance.close();
  }
}

wss.on('connection', (ws) => {
  console.log('Client connected');
  // Initialize per-connection state
  connectionState.set(ws, { lastRun: null });
  sendState(ws, STATE.IDLE);
  const docs = loadAllDocs();
  send(ws, 'suggestions', { payload: docs.length > 0 ? docs.map(d => `Test ${d.name}`) : ['Test login'] });
  ws.on('message', async (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'prompt') orchestrate(ws, msg.data);
  });
  ws.on('close', () => {
    connectionState.delete(ws);
    console.log('Client disconnected');
  });
});

server.listen(4000, () => {
  console.log('QA Agent:  http://localhost:4000');
  console.log('Test app:  http://localhost:4000/testapp');
});