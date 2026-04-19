import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { chromium } from 'playwright';
dotenv.config();

import { analyzeRequest, generateAllScenarioSteps, fixSteps } from './agent.js';
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

// ── Core helpers ───────────────────────────────────────────────────────────────
function send(ws, type, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type, data }));
}
function log(ws, text, level = 'info') {
  if (!text || !text.trim()) return;
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

// ── Emotional / conversational intent detection ────────────────────────────────
// Detects when user is NOT asking to run a test but having a human conversation
const EMOTIONAL_PATTERNS = [
  /\b(new (to|here|in)|just joined|just started|onboard|first (day|week|time))\b/i,
  /\b(guide|help me understand|walk me through|show me|explain|teach me|how does|what should i|where do i start)\b/i,
  /\b(confused|lost|overwhelmed|don'?t know|not sure|unsure|clueless)\b/i,
  /\b(could you|can you|would you|please)\b.*\b(help|guide|explain|tell)\b/i,
  /\b(what (is|are|does)|how (do|does|can|should)|why (is|does))\b/i,
  /\b(nervous|excited|worried|anxious|scared|afraid)\b/i,
  /\bi (am|'m) (a |an )?(new|junior|senior|lead|qa|tester|developer|engineer)/i,
];

const GREET_PHRASES = ['hi', 'hello', 'hey', 'help', 'what can you do', 'what do you do', 'who are you', 'good morning', 'good afternoon', 'good evening'];

function isEmotionalOrConversational(input) {
  const lower = input.toLowerCase().trim();
  if (GREET_PHRASES.some(p => lower === p || lower.startsWith(p + ' ') || lower.startsWith(p + ','))) return true;
  return EMOTIONAL_PATTERNS.some(p => p.test(lower));
}

// ── Warm conversational response using LLM ─────────────────────────────────────
async function generateWarmResponse(userInput, allDocs) {
  const modules = allDocs.map(d => d.name);
  const scenarioSummary = allDocs.map(d => {
    const section = d.content.match(/##\s*Test Scenarios\s*\n([\s\S]*?)(?=\n##|$)/i);
    if (!section) return `${d.name}: (no scenarios documented)`;
    const lines = section[1].trim().split('\n')
      .map(l => { const m = l.match(/[-*]\s*([a-z_]+):\s*(.+)/i); return m ? `  • ${m[1].replace(/_/g,' ')}` : null; })
      .filter(Boolean);
    return `${d.name}:\n${lines.join('\n')}`;
  }).join('\n\n');

  const prompt = `${IDENTITY_ANCHOR}

You are a warm, experienced QA team member — a partner and mentor, not just a tool.
The new team member said: "${userInput}"

The application has these testable modules and scenarios:
${scenarioSummary}

Respond conversationally and warmly in 3–5 sentences. 
- Acknowledge their situation with empathy
- Briefly orient them to what the app does and what we can test
- Give 1–2 concrete suggestions for where to start (e.g. "test login" or "tell me about dashboard")
- Keep it friendly and encouraging, like a colleague on Slack
- Do NOT list every module exhaustively. Be concise and human.
- Do NOT output JSON or markdown headers.`;

  const result = await llmGenerate(prompt);
  return result.response.text().trim();
}

// ── Specific scenario resolution ───────────────────────────────────────────────
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
    let msg = `Here's what I know about the ${matchedDoc.name} module:\n\n`;
    if (urlMatch) msg += `URL: ${urlMatch[1]}\n\n`;
    if (desc) msg += `${desc}\n\n`;
    if (scenarios.length > 0) {
      msg += `Test scenarios:\n${scenarios.map((s, i) => `${i+1}. ${s.name} — ${s.description}`).join('\n')}\n\n`;
      msg += `Say "test ${matchedDoc.name}" to run all, or pick a specific one.`;
    }
    return msg;
  }
  const modules = [...new Set(docs.map(d => d.name))];
  return `I can test these modules:\n${modules.map(m => `• ${m}`).join('\n')}\n\nAsk about any one to learn more, or say "test [module]" to run tests.`;
}

// ── Confirm execution ──────────────────────────────────────────────────────────
async function confirmExecution(ws, scenario, plan) {
  const finalPlan = { ...plan, scenarioId: scenario.id };
  send(ws, 'plan', finalPlan);

  const stepLines = plan.steps.slice(0, 6).map((s, i) => {
    const target = s.selector || s.value || '';
    const label = {
      navigate: `Navigate to ${target}`,
      type: `Type "${s.value}" into ${s.selector}`,
      click: `Click ${s.selector}`,
      expect: `Expect ${s.selector} to be visible`,
      expecturl: `Expect URL to contain ${s.value}`,
      waitfornavigation: `Wait for page to load`,
      asserttext: `Verify text "${s.value}" in ${s.selector}`,
    }[s.action?.toLowerCase()] || `${s.action} ${target}`;
    return `${i+1}. ${label}`;
  }).join('\n');
  const extra = plan.steps.length > 6 ? `\n   ...+${plan.steps.length - 6} more` : '';

  send(ws, 'question', {
    text: `${scenario.name}\n\n${stepLines}${extra}`,
    type: 'confirm_run',
    meta: { scenarioName: scenario.name, totalSteps: plan.steps.length },
  });

  const answer = await waitForAnswer(ws);
  return /yes|run|ok|confirm|go|start/i.test(answer);
}

// ── Execute one plan ───────────────────────────────────────────────────────────
async function executePlan(ws, plan, scenario, userInput, baseUrl, browser) {
  const finalPlan = injectDocUrl(plan, baseUrl);
  send(ws, 'plan', { ...finalPlan, scenarioId: scenario.id });
  sendState(ws, STATE.EXECUTING);
  phase(ws, '── Executing steps ──');

  let result = await runSteps(finalPlan.steps, {
    browser, baseUrl,
    onStep: (index, step, status) => send(ws, 'step', { index, status }),
    onLog:  (text, level) => log(ws, text, level),
  });

  let healCount = 0;
  let healMeta = null;

  if (result.status === 'failed') {
    phase(ws, '── Step failed ──');
    log(ws, `Error: ${result.error}`, 'error');
    const failedStepResult = result.results?.find(r => r.status === 'failed');

    // ── Enhanced heal — send richer context including DOM diff ──────────────
    const failedIndex = failedStepResult ? result.results.indexOf(failedStepResult) : -1;
    send(ws, 'question', {
      text: result.error,
      type: 'heal_choice',
      meta: {
        failedStep: failedStepResult?.step,
        failedIndex,
        error: result.error,
        totalSteps: finalPlan.steps.length,
        passedCount: result.results?.filter(r => r.status === 'success').length || 0,
      },
    });
    const choice = await waitForAnswer(ws);

    if (/yes|heal|try|fix|retry/i.test(choice)) {
      phase(ws, '── Auto-healing ──');
      log(ws, 'Capturing fresh browser snapshot...', 'info');

      // Capture both DOM snapshot and a screenshot hint
      const freshCtx = await captureBrowserContext(baseUrl);
      log(ws, `DOM captured: ${freshCtx.split('\n').length} elements`, 'info');
      log(ws, 'Asking LLM for corrected steps...', 'info');

      // Build rich heal context
      const healContext = buildHealContext(finalPlan, result, failedStepResult, freshCtx);
      const fixedPlan = await fixSteps(finalPlan, result.error, userInput, healContext);
      validatePlan(fixedPlan);

      const fixedWithUrl = injectDocUrl(fixedPlan, baseUrl);

      // Emit diff between original and healed plan
      const diffData = computePlanDiff(finalPlan.steps, fixedWithUrl.steps);
      send(ws, 'heal_diff', diffData);

      send(ws, 'plan', { ...fixedWithUrl, scenarioId: scenario.id });
      phase(ws, '── Retrying healed plan ──');
      result = await runSteps(fixedWithUrl.steps, {
        browser, baseUrl,
        onStep: (index, step, status) => send(ws, 'step', { index, status }),
        onLog:  (text, level) => log(ws, text, level),
      });
      healCount++;

      if (result.status === 'success') {
        log(ws, 'Heal succeeded ✓', 'success');
        phase(ws, '── Saving healed plan ──');
        saveToMemory(fixedPlan);
        log(ws, `Cached: "${fixedPlan.module}__${fixedPlan.scenario}"`, 'success');
        const fixedStep = fixedPlan.steps[failedStepResult?.index];
        healMeta = {
          originalError: result.error || failedStepResult?.error,
          failedStep: failedStepResult?.step,
          failedIndex,
          fixedStep,
          stepIndex: failedStepResult?.index,
          diff: diffData,
        };
      } else {
        log(ws, 'Heal also failed', 'error');
        // Emit second-pass failure for the UI to show
        send(ws, 'heal_failed', { error: result.error, attempts: 1 });
      }
    } else {
      log(ws, 'Stopped by user', 'warn');
    }
  } else {
    phase(ws, '── Saving to memory ──');
    saveToMemory(finalPlan);
    log(ws, `Cached: "${finalPlan.module}__${finalPlan.scenario}"`, 'success');
  }

  return { result, healCount, healMeta };
}

// ── Heal helpers ───────────────────────────────────────────────────────────────

function buildHealContext(plan, result, failedStep, freshDom) {
  const passedSteps = result.results?.filter(r => r.status === 'success').map(r =>
    `✓ ${r.step?.action} ${r.step?.selector || r.step?.value || ''}`
  ) || [];
  const failedLine = failedStep
    ? `✗ ${failedStep.step?.action} ${failedStep.step?.selector || failedStep.step?.value || ''} — ERROR: ${failedStep.error || result.error}`
    : '';

  return `Current DOM state:\n${freshDom}\n\nExecution trace:\n${[...passedSteps, failedLine].join('\n')}`;
}

function computePlanDiff(original, healed) {
  const changes = [];
  const maxLen = Math.max(original.length, healed.length);
  for (let i = 0; i < maxLen; i++) {
    const orig = original[i];
    const heal = healed[i];
    if (!orig && heal) {
      changes.push({ type: 'added', index: i, step: heal });
    } else if (orig && !heal) {
      changes.push({ type: 'removed', index: i, step: orig });
    } else if (orig && heal) {
      const origKey = `${orig.action}:${orig.selector||''}:${orig.value||''}`;
      const healKey = `${heal.action}:${heal.selector||''}:${heal.value||''}`;
      if (origKey !== healKey) {
        changes.push({ type: 'changed', index: i, original: orig, healed: heal });
      }
    }
  }
  return { changes, originalLength: original.length, healedLength: healed.length };
}

// ── Router ─────────────────────────────────────────────────────────────────────
function routeRequest(userInput, docScenarios) {
  const lower = userInput.toLowerCase().trim();
  if (isEmotionalOrConversational(userInput)) return 'EMOTIONAL';
  if (/\b(what|tell me|show me|explain|describe|about|how does|info|information|learn)\b/.test(lower)) return 'EXPLORE';
  const specific = resolveSpecificScenario(lower, docScenarios);
  if (specific) return { route: 'SPECIFIC', scenario: specific };
  if (docScenarios.length > 0) return 'MODULE';
  return 'ANALYZE';
}

// ── Shared scenario runner ─────────────────────────────────────────────────────
async function runScenarios(ws, toRun, getPlan, userInput, baseUrl, browserInstance, confirmEach = true) {
  const scenarioResults = [];
  let totalHealed = 0;

  for (let i = 0; i < toRun.length; i++) {
    const s = toRun[i];
    const plan = typeof getPlan === 'function' ? getPlan(s) : getPlan.find(r => r.scenario.id === s.id)?.cached;

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

// ── MAIN ORCHESTRATION ─────────────────────────────────────────────────────────
async function orchestrate(ws, userInput) {
  let browserInstance = null;

  try {
    const guard = guardCheck(userInput);
    if (!guard.safe) { send(ws, 'agent_message', guard.reason); return; }

    sendState(ws, STATE.GATHERING_CONTEXT);
    phase(ws, '── Loading context ──');
    log(ws, 'Reading documentation...', 'info');
    const docContext   = getRelevantContext(userInput);
    const baseUrl      = extractBaseUrl(userInput) || process.env.BASE_URL || 'http://localhost:4000/testapp';
    const docScenarios = extractDocScenarios(userInput);
    const allDocs      = loadAllDocs();
    const module       = docScenarios[0]?.module || 'general';

    if (docContext) log(ws, `Docs loaded: ${module}`, 'success');
    else log(ws, 'No matching docs found', 'warn');

    const route = routeRequest(userInput, docScenarios);

    // ── Route: Emotional / Conversational ─────────────────────────────────────
    if (route === 'EMOTIONAL') {
      log(ws, 'Conversational intent detected', 'info');
      const warmReply = await generateWarmResponse(userInput, allDocs);
      send(ws, 'agent_message', warmReply);
      sendState(ws, STATE.IDLE);
      return;
    }

    // ── Route: Explore ────────────────────────────────────────────────────────
    if (route === 'EXPLORE') {
      send(ws, 'agent_message', buildExploreResponse(docScenarios, allDocs, userInput));
      return;
    }

    // ── Route: Regression ────────────────────────────────────────────────────
    if (/\bregression\b/i.test(userInput)) {
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
      phase(ws, '── Checking memory ──');
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
        }
      }
      send(ws, 'regression_plan', { modules: allDocs.map(d => ({ name: d.name, scenarios: allScenarios.filter(s => s.module === d.name) })), total: allScenarios.length });
      const choice = await waitForAnswer(ws);

      if (!/yes|run|ok|confirm|go|start|all/i.test(choice)) {
        phase(ws, '── Regression cancelled ──');
        log(ws, 'Regression cancelled by user.', 'warn');
        send(ws, 'agent_message', 'Regression cancelled. Let me know when you\'re ready.');
        sendState(ws, STATE.IDLE);
        return;
      }

      sendState(ws, STATE.EXECUTING);
      browserInstance = await chromium.launch({ headless: false });
      const { scenarioResults, totalHealed } = await runScenarios(ws, allScenarios, (s) => memoryCheck.find(r => r.scenario.id === s.id && r.scenario.module === s.module)?.cached, userInput, baseUrl, browserInstance, false);
      const passed = scenarioResults.filter(r => r.result.status === 'success').length;
      const failed = scenarioResults.filter(r => r.result.status === 'failed').length;
      const skipped = scenarioResults.filter(r => r.result.status === 'skipped').length;
      send(ws, 'report', { type: 'regression', status: failed === 0 ? 'success' : 'failed', healCount: totalHealed, scenarios: scenarioResults, summary: { total: scenarioResults.length, passed, failed, skipped, healed: totalHealed } });
      sendState(ws, STATE.IDLE);
      return;
    }

    // ── Route: Specific ───────────────────────────────────────────────────────
    if (route?.route === 'SPECIFIC') {
      const s = route.scenario;
      log(ws, `Matched: "${s.name}"`, 'success');
      log(ws, s.description, 'info');
      send(ws, 'scenario_start', s);
      phase(ws, '── Checking memory ──');
      const cached = findSimilarPlan(s.module, s.id, userInput);
      let plan = cached;
      if (cached) {
        log(ws, `Memory hit — ${cached.steps?.length} steps cached`, 'success');
      } else {
        log(ws, 'Cache miss — generating via LLM', 'info');
        phase(ws, '── Capturing browser state ──');
        const browserCtx = await captureBrowserContext(baseUrl);
        phase(ws, '── Generating test plan ──');
        const batch = await generateAllScenarioSteps([s], docContext, browserCtx);
        plan = batch[0];
        validatePlan(plan);
        log(ws, `Plan ready: ${plan.steps?.length} steps`, 'success');
        saveToMemory(plan);
      }
      const confirmed = await confirmExecution(ws, s, plan);
      if (!confirmed) { send(ws, 'agent_message', 'No problem — just say the word when you\'re ready.'); sendState(ws, STATE.IDLE); return; }
      browserInstance = await chromium.launch({ headless: false });
      const { result, healCount, healMeta } = await executePlan(ws, plan, s, userInput, baseUrl, browserInstance);
      send(ws, 'report', { status: result.status, healCount, scenarios: [{ scenario: s, result, healCount, healMeta }], summary: { total: 1, passed: result.status === 'success' ? 1 : 0, failed: result.status === 'failed' ? 1 : 0, skipped: 0, healed: healCount } });
      sendState(ws, STATE.IDLE);
      return;
    }

    // ── Route: Module ─────────────────────────────────────────────────────────
    if (route === 'MODULE') {
      phase(ws, '── Checking memory ──');
      const memoryCheck = docScenarios.map(s => ({ scenario: s, cached: findSimilarPlan(module, s.id, userInput) }));
      const cachedCount = memoryCheck.filter(r => r.cached).length;
      log(ws, `${cachedCount} of ${docScenarios.length} scenarios cached`, cachedCount === docScenarios.length ? 'success' : 'info');
      const uncached = memoryCheck.filter(r => !r.cached).map(r => r.scenario);
      if (uncached.length > 0) {
        phase(ws, '── Capturing browser state ──');
        const browserCtx = await captureBrowserContext(baseUrl);
        phase(ws, '── Generating missing plans ──');
        const batch = await generateAllScenarioSteps(uncached, docContext, browserCtx);
        batch.forEach(p => { validatePlan(p); saveToMemory(p); const m = memoryCheck.find(r => r.scenario.id === p.id); if (m) m.cached = p; });
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
      const passed = scenarioResults.filter(r => r.result.status === 'success').length;
      const failed = scenarioResults.filter(r => r.result.status === 'failed').length;
      const skipped = scenarioResults.filter(r => r.result.status === 'skipped').length;
      send(ws, 'report', { status: failed === 0 ? 'success' : 'failed', healCount: totalHealed, scenarios: scenarioResults, summary: { total: scenarioResults.length, passed, failed, skipped, healed: totalHealed } });
      sendState(ws, STATE.IDLE);
      return;
    }

    // ── Route: LLM Analysis ───────────────────────────────────────────────────
    phase(ws, '── Analyzing request ──');
    const browserCtx = await captureBrowserContext(baseUrl);
    const { enrichedInput } = await gatherContext(userInput, null, (q) => askUser(ws, q), (t, l) => log(ws, t, l));
    const analysis = await analyzeRequest(enrichedInput, docContext, browserCtx);
    send(ws, 'intent', { intent: analysis.intent, confidence: 'high' });
    if (analysis.intent === 'OUT_OF_SCOPE') { send(ws, 'agent_message', outOfScopeResponse(userInput)); return; }
    if (analysis.intent === 'EXPLORE' || analysis.intent === 'UNDERSTAND') { send(ws, 'agent_message', buildExploreResponse(docScenarios, allDocs, userInput)); return; }
    const scenarios = docScenarios.length > 0 ? docScenarios : (analysis.scenarios || []);
    if (!scenarios.length) { send(ws, 'agent_message', 'Could not identify scenarios. Try being more specific — e.g. "test login with invalid password".'); return; }
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
    send(ws, 'report', { status: rf === 0 ? 'success' : 'failed', healCount: rh, scenarios: rr, summary: { total: rr.length, passed: rp, failed: rf, skipped: rs, healed: rh } });
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
  sendState(ws, STATE.IDLE);
  const docs = loadAllDocs();
  send(ws, 'suggestions', { payload: docs.length > 0 ? docs.map(d => `Test ${d.name}`) : ['Test login'] });
  ws.on('message', async (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'prompt') orchestrate(ws, msg.data);
  });
  ws.on('close', () => console.log('Client disconnected'));
});

server.listen(4000, () => {
  console.log('QA Agent:  http://localhost:4000');
  console.log('Test app:  http://localhost:4000/testapp');
});