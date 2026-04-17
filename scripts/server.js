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

app.get('/.well-known/appspecific/com.chrome.devtools.json', (req, res) => {
  res.json({ name: 'com.chrome.devtools', version: 1 });
});

app.use(express.static(ROOT));
app.use('/testapp', express.static(path.join(ROOT, 'public', 'testapp')));
app.get('/testapp', (req, res) => res.sendFile(path.join(ROOT, 'public', 'testapp.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(ROOT, 'public', 'dashboard.html')));
app.get('/projects',  (req, res) => res.sendFile(path.join(ROOT, 'public', 'projects.html')));
app.get('/profile',   (req, res) => res.sendFile(path.join(ROOT, 'public', 'profile.html')));

// ── Helpers ───────────────────────────────────────────────────────────────────

function send(ws, type, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type, data }));
}

function log(ws, text, level = 'info') {
  if (!text || !text.trim()) return;
  console.log(`[${level.toUpperCase()}] ${text}`);
  send(ws, 'log', { text, level });
}

function sendState(ws, state) { send(ws, 'agent_state', state); }

function waitForAnswer(ws, timeoutMs = 120000) {
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

// ── FIX 1: Word-boundary scoring — prevents "valid" matching inside "invalid" ─
// Uses unique deduplicated keywords and whole-word matching via regex.

function resolveSpecificScenario(input, docScenarios) {
  const lower = input.toLowerCase();

  // Build a word-boundary test: only match whole words, not substrings
  function matchesWholeWord(text, word) {
    // Escape special regex chars in word
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`).test(text);
  }

  const scored = docScenarios.map(s => {
    // Collect all keywords then DEDUPLICATE — stops duplicate counting
    const raw = [
      ...s.id.split('_'),
      ...s.name.toLowerCase().split(/\s+/),
    ].filter(w => w.length > 2);
    const keywords = [...new Set(raw)]; // deduplicate

    const matches = keywords.filter(kw => matchesWholeWord(lower, kw));
    return { scenario: s, score: matches.length, matches };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);

  if (!scored.length) return null;

  const top = scored[0];
  const second = scored[1];

  // Need a clear winner OR at least 2 matching keywords
  const clearWinner = !second || top.score > second.score;
  const confident = top.score >= 2;

  return (clearWinner && confident) ? top.scenario : null;
}

// ── Execute one plan ──────────────────────────────────────────────────────────

async function executePlan(ws, plan, scenarioId, userInput, baseUrl, browser) {
  const finalPlan = injectDocUrl(plan, baseUrl);

  // Short delay before execution — gives the user a moment to see the plan
  await new Promise(r => setTimeout(r, 600));

  send(ws, 'plan', { ...finalPlan, scenarioId });
  sendState(ws, STATE.EXECUTING);

  let result = await runSteps(finalPlan.steps, {
    browser,
    baseUrl,
    onStep: (index, step, status) => send(ws, 'step', { index, status }),
    onLog:  (text, level) => log(ws, text, level),
  });

  let healCount = 0;

  if (result.status === 'failed') {
    log(ws, `Step failed: ${result.error}`, 'error');
    const choice = await askUser(ws, `A step failed: "${result.error}". What should I do?`, 'heal_choice');

    if (/yes|heal|try|fix|retry/i.test(choice)) {
      log(ws, 'Auto-healing — refreshing DOM...', 'warn');
      const freshCtx = await captureBrowserContext(baseUrl);
      const fixedPlan = await fixSteps(finalPlan, result.error, userInput, freshCtx);
      validatePlan(fixedPlan);
      const fixedWithUrl = injectDocUrl(fixedPlan, baseUrl);
      send(ws, 'plan', { ...fixedWithUrl, scenarioId });

      result = await runSteps(fixedWithUrl.steps, {
        browser, baseUrl,
        onStep: (index, step, status) => send(ws, 'step', { index, status }),
        onLog:  (text, level) => log(ws, text, level),
      });

      healCount++;
      if (result.status === 'success') { saveToMemory(fixedPlan); log(ws, 'Heal successful — memory updated', 'success'); }
      else log(ws, 'Heal failed', 'error');
    } else {
      log(ws, 'Stopped by user', 'warn');
    }
  } else {
    saveToMemory(finalPlan);
    log(ws, 'Passed', 'success');
  }

  return { result, healCount };
}

// ── Router ────────────────────────────────────────────────────────────────────

function routeRequest(userInput, docScenarios) {
  const lower = userInput.toLowerCase().trim();
  if (['hi', 'hello', 'hey', 'help', 'what can you do'].includes(lower)) return 'GREET';

  const specific = resolveSpecificScenario(lower, docScenarios);
  if (specific) return { route: 'SPECIFIC', scenario: specific };

  if (docScenarios.length > 0) return 'MODULE';
  return 'ANALYZE';
}

// ── MAIN ORCHESTRATION ────────────────────────────────────────────────────────

async function orchestrate(ws, userInput) {
  let browserInstance = null;

  try {
    const guard = guardCheck(userInput);
    if (!guard.safe) { send(ws, 'agent_message', guard.reason); return; }

    sendState(ws, STATE.GATHERING_CONTEXT);

    const docContext   = getRelevantContext(userInput);
    const baseUrl      = extractBaseUrl(userInput) || process.env.BASE_URL || 'http://localhost:4000/testapp';
    const docScenarios = extractDocScenarios(userInput);
    const module       = docScenarios[0]?.module || 'general';
    const route        = routeRequest(userInput, docScenarios);

    // ── Route A: Greet ──────────────────────────────────────────────────────
    if (route === 'GREET') {
      const modules = [...new Set(loadAllDocs().map(d => d.name))];
      send(ws, 'agent_message', `I can test:\n${modules.map(m => `• ${m}`).join('\n')}\n\nTry "test login" or "test login with invalid password".`);
      return;
    }

    // ── Route B: Specific single scenario ──────────────────────────────────
    if (route?.route === 'SPECIFIC') {
      const s = route.scenario;
      log(ws, `Matched scenario: "${s.name}"`, 'info');
      send(ws, 'scenario_start', s);

      const cached = findSimilarPlan(s.module, s.id, userInput);
      let plan = cached;

      if (cached) {
        log(ws, 'Memory hit — reusing cached plan', 'success');
      } else {
        log(ws, 'Generating plan via Gemini...', 'info');
        const browserCtx = await captureBrowserContext(baseUrl);
        const batch = await generateAllScenarioSteps([s], docContext, browserCtx);
        plan = batch[0];
        validatePlan(plan);
        saveToMemory(plan);
        log(ws, 'Plan saved to memory', 'success');
      }

      browserInstance = await chromium.launch({ headless: false });
      const { result, healCount } = await executePlan(ws, plan, s.id, userInput, baseUrl, browserInstance);

      send(ws, 'report', {
        status: result.status, healCount,
        scenarios: [{ scenario: s, result, healCount }],
        summary: { total: 1, passed: result.status === 'success' ? 1 : 0, failed: result.status === 'failed' ? 1 : 0, healed: healCount },
      });
      sendState(ws, STATE.IDLE);
      return;
    }

    // ── Route C: Module-level — check memory, show picker ──────────────────
    if (route === 'MODULE') {
      const memoryCheck = docScenarios.map(s => ({ scenario: s, cached: findSimilarPlan(module, s.id, userInput) }));
      const allCached = memoryCheck.length > 0 && memoryCheck.every(r => r.cached);

      if (!allCached) {
        log(ws, 'Generating plans for uncached scenarios...', 'info');
        const browserCtx = await captureBrowserContext(baseUrl);
        const uncached = memoryCheck.filter(r => !r.cached).map(r => r.scenario);
        const batch = await generateAllScenarioSteps(uncached, docContext, browserCtx);
        batch.forEach(p => {
          validatePlan(p); saveToMemory(p);
          const m = memoryCheck.find(r => r.scenario.id === p.id);
          if (m) m.cached = p;
        });
        log(ws, 'All plans ready', 'success');
      } else {
        log(ws, `All ${docScenarios.length} scenarios in memory`, 'success');
      }

      sendState(ws, STATE.PLANNING);
      send(ws, 'scenarios', { scenarios: docScenarios, module: userInput });
      const choice = await waitForAnswer(ws);
      send(ws, 'answer_received', choice);

      const toRun = choice.toLowerCase().includes('all')
        ? docScenarios
        : (() => {
            const indices = [...choice.matchAll(/\d+/g)].map(m => parseInt(m[0]) - 1);
            return indices.length > 0
              ? indices.filter(i => i >= 0 && i < docScenarios.length).map(i => docScenarios[i])
              : docScenarios;
          })();

      sendState(ws, STATE.EXECUTING);
      browserInstance = await chromium.launch({ headless: false });
      const scenarioResults = [];
      let totalHealed = 0;

      for (let i = 0; i < toRun.length; i++) {
        const s = toRun[i];
        const plan = memoryCheck.find(r => r.scenario.id === s.id)?.cached;
        if (!plan) { log(ws, `No plan for "${s.name}" — skipping`, 'warn'); continue; }
        send(ws, 'scenario_start', s);
        log(ws, `Running: ${s.name}`);
        const { result, healCount } = await executePlan(ws, plan, s.id, userInput, baseUrl, browserInstance);
        scenarioResults.push({ scenario: s, result, healCount });
        totalHealed += healCount;
        if (i < toRun.length - 1) { await new Promise(r => setTimeout(r, 600)); log(ws, '─────────────────────'); }
      }

      const passed = scenarioResults.filter(r => r.result.status === 'success').length;
      const failed = scenarioResults.filter(r => r.result.status === 'failed').length;
      send(ws, 'report', { status: failed === 0 ? 'success' : 'failed', healCount: totalHealed, scenarios: scenarioResults, summary: { total: toRun.length, passed, failed, healed: totalHealed } });
      sendState(ws, STATE.IDLE);
      return;
    }

    // ── Route D: Unknown — LLM analysis ────────────────────────────────────
    log(ws, 'Analyzing request...', 'info');
    const browserCtx = await captureBrowserContext(baseUrl);
    const { enrichedInput } = await gatherContext(userInput, null, (q) => askUser(ws, q), (t, l) => log(ws, t, l));
    const analysis = await analyzeRequest(enrichedInput, docContext, browserCtx);
    send(ws, 'intent', { intent: analysis.intent, confidence: 'high' });

    if (analysis.intent === 'OUT_OF_SCOPE') { send(ws, 'agent_message', outOfScopeResponse(userInput)); return; }
    if (analysis.intent === 'EXPLORE' || analysis.intent === 'UNDERSTAND') {
      const modules = [...new Set(loadAllDocs().map(d => d.name))];
      send(ws, 'agent_message', `I know about:\n${modules.map(m => `• ${m}`).join('\n')}\n\nTry "test [module name]".`);
      return;
    }

    const scenarios = docScenarios.length > 0 ? docScenarios : (analysis.scenarios || []);
    if (!scenarios.length) { send(ws, 'agent_message', 'Could not identify scenarios. Try being more specific.'); return; }

    sendState(ws, STATE.PLANNING);
    const planMap = {};
    const stillUncached = scenarios.filter(s => { const p = findSimilarPlan(module, s.id); if (p) { planMap[s.id] = p; return false; } return true; });
    if (stillUncached.length > 0) {
      const batch = await generateAllScenarioSteps(stillUncached, docContext, browserCtx);
      batch.forEach(p => { validatePlan(p); saveToMemory(p); planMap[p.id] = p; });
    }

    send(ws, 'scenarios', { scenarios, module: userInput });
    const choice = await waitForAnswer(ws);
    send(ws, 'answer_received', choice);
    const finalToRun = choice.toLowerCase().includes('all') ? scenarios : (() => {
      const indices = [...choice.matchAll(/\d+/g)].map(m => parseInt(m[0]) - 1);
      return indices.length > 0 ? indices.filter(i => i >= 0 && i < scenarios.length).map(i => scenarios[i]) : scenarios;
    })();

    sendState(ws, STATE.EXECUTING);
    browserInstance = await chromium.launch({ headless: false });
    const results = []; let healed = 0;
    for (let i = 0; i < finalToRun.length; i++) {
      const s = finalToRun[i];
      if (!planMap[s.id]) { log(ws, `No plan for "${s.name}" — skipping`, 'warn'); continue; }
      send(ws, 'scenario_start', s);
      const { result, healCount } = await executePlan(ws, planMap[s.id], s.id, enrichedInput, baseUrl, browserInstance);
      results.push({ scenario: s, result, healCount }); healed += healCount;
      if (i < finalToRun.length - 1) { await new Promise(r => setTimeout(r, 600)); log(ws, '─────────────────────'); }
    }
    const p = results.filter(r => r.result.status === 'success').length;
    const f = results.filter(r => r.result.status === 'failed').length;
    send(ws, 'report', { status: f === 0 ? 'success' : 'failed', healCount: healed, scenarios: results, summary: { total: finalToRun.length, passed: p, failed: f, healed } });
    sendState(ws, STATE.IDLE);

  } catch (err) {
    log(ws, err.message, 'error');
    send(ws, 'error', err.message);
    sendState(ws, STATE.IDLE);
  } finally {
    if (browserInstance) await browserInstance.close();
  }
}

// ── WebSocket ──────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('Client connected');
  sendState(ws, STATE.IDLE);

  // Send doc-based suggestions immediately on connect
  const docs = loadAllDocs();
  const suggestions = docs.length > 0
    ? docs.map(d => `Test ${d.name}`)
    : ['Test login', 'Explore the app'];
  send(ws, 'suggestions', { payload: suggestions });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'prompt') orchestrate(ws, msg.data);
  });
  ws.on('close', () => console.log('Client disconnected'));
});

server.listen(4000, () => {
  console.log('QA Agent:  http://localhost:4000');
  console.log('Test app:  http://localhost:4000/testapp');
});