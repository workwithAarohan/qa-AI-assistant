import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config();

import { analyzeRequest, generateAllScenarioSteps, generateSteps, fixSteps } from './agent.js';
import { runSteps } from './executor.js';
import { validatePlan } from './validator.js';
import { saveToMemory, findSimilarPlan, deduplicateMemory } from './memory.js';
import { getRelevantContext } from './context.js';
import { captureBrowserContext } from './browser-context.js';
import { guardCheck } from './guard.js';
import { STATE, outOfScopeResponse } from './classifier.js';
import { gatherContext } from './context-gatherer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// CSP to allow same-origin connect, tailwind CDN and inline styles/scripts
app.use((req, res, next) => {
  const csp = [
    "default-src 'self'",
    "connect-src 'self' ws:",
    "script-src 'self' https://cdn.tailwindcss.com 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
  ].join('; ');
  res.setHeader('Content-Security-Policy', csp);
  next();
});

// Serve DevTools app-specific manifest to avoid 404/CSP console noise
app.get('/.well-known/appspecific/com.chrome.devtools.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  return res.json({ name: 'com.chrome.devtools', description: 'Local DevTools app manifest', version: 1 });
});

app.use(express.static(ROOT));
app.use('/testapp', express.static(path.join(ROOT, 'public', 'testapp')));
app.get(/^\/testapp\/?.*$/, (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'testapp.html'));
});

// clean duplicates on startup
const dr = deduplicateMemory();
if (dr.removed > 0) console.log(`Memory: ${dr.before} → ${dr.after} entries (${dr.removed} dupes removed)`);

// ── Comms helpers ─────────────────────────────────────────────────────────────

function send(ws, type, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type, data }));
}

function log(ws, text, level = 'info') {
  console.log(`[${level.toUpperCase()}] ${text}`);
  send(ws, 'log', { text, level });
}

function sendState(ws, state) {
  send(ws, 'agent_state', state);
}

function waitForAnswer(ws, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Answer timeout')), timeoutMs);
    ws.once('message', (raw) => {
      clearTimeout(timer);
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'answer') resolve(msg.data);
        else reject(new Error('Expected answer'));
      } catch (err) { reject(err); }
    });
  });
}

async function askUser(ws, question) {
  send(ws, 'question', question);
  const answer = await waitForAnswer(ws);
  send(ws, 'answer_received', answer);
  return answer;
}

// ── Execute one plan ──────────────────────────────────────────────────────────

async function executePlan(ws, plan, scenarioId, userInput) {
  send(ws, 'plan', { ...plan, scenarioId });
  sendState(ws, STATE.EXECUTING);

  let result = await runSteps(plan.steps, (index, step, status) => {
    send(ws, 'step', { index, step, status, scenarioId });
  });

  let healCount = 0;

  if (result.status === 'failed') {
    log(ws, `Step failed: ${result.error}`, 'error');
    const choice = await askUser(ws, `Step failed: "${result.error}". Auto-heal or stop?`);

    if (/yes|heal|try|fix|retry/i.test(choice)) {
      log(ws, 'Auto-healing — refreshing DOM...', 'warn');
      const freshCtx = await captureBrowserContext();
      const fixedPlan = await fixSteps(plan, result.error, userInput, freshCtx);
      validatePlan(fixedPlan);
      send(ws, 'plan', { ...fixedPlan, scenarioId });

      result = await runSteps(fixedPlan.steps, (index, step, status) => {
        send(ws, 'step', { index, step, status, scenarioId });
      });

      healCount++;
      if (result.status === 'success') {
        saveToMemory(fixedPlan);
        log(ws, 'Heal successful — memory updated', 'success');
      } else {
        log(ws, 'Heal failed', 'error');
      }
    } else {
      log(ws, 'Stopped by user', 'warn');
    }
  } else {
    saveToMemory(plan);
    log(ws, `Passed`, 'success');
  }

  return { result, healCount };
}

// ── MAIN ORCHESTRATION ────────────────────────────────────────────────────────

async function orchestrate(ws, userInput) {
  try {

    // ── Layer 2: Guard ───────────────────────────────────────────────────────
    const guard = guardCheck(userInput);
    if (!guard.safe) {
      send(ws, 'agent_message', guard.reason);
      send(ws, 'report', { status: 'blocked', results: [], healCount: 0, summary: { total: 0, passed: 0, failed: 0, healed: 0 } });
      return;
    }

    sendState(ws, STATE.GATHERING_CONTEXT);

    // ── Layers 3+4+5: ONE merged LLM call ────────────────────────────────────
    // Replaces: classifyIntent + checkReadiness + identifyScenarios
    // Cost: 1 LLM call instead of 3

    log(ws, 'Loading context...');
    const docContext     = getRelevantContext(userInput);
    const browserContext = await captureBrowserContext();
    if (docContext) log(ws, 'Docs loaded', 'success');
    log(ws, 'DOM captured', 'success');

    log(ws, 'Analyzing request...');
    const analysis = await analyzeRequest(userInput, docContext, browserContext);
    // analysis = { intent, ready, clarifying_question, scenarios }

    log(ws, `Intent: ${analysis.intent}`, 'info');
    send(ws, 'intent', { intent: analysis.intent, confidence: 'high' });

    // ── Out of scope ─────────────────────────────────────────────────────────
    if (analysis.intent === 'OUT_OF_SCOPE') {
      send(ws, 'agent_message', outOfScopeResponse(userInput));
      send(ws, 'report', { status: 'out_of_scope', results: [], healCount: 0, summary: { total: 0, passed: 0, failed: 0, healed: 0 } });
      return;
    }

    // ── Explore / Understand — no execution ──────────────────────────────────
    if (analysis.intent === 'EXPLORE' || analysis.intent === 'UNDERSTAND') {
      send(ws, 'agent_message', `I can help with that. Try: "what scenarios should I cover for [feature]?" or "test [feature name]" to run automation.`);
      send(ws, 'report', { status: 'success', results: [], healCount: 0, summary: { total: 0, passed: 0, failed: 0, healed: 0 } });
      return;
    }

    // ── Clarifying question if not ready ─────────────────────────────────────
    let enrichedInput = userInput;
    if (!analysis.ready && analysis.clarifying_question) {
      log(ws, 'Asking clarifying question...');
      const answer = await askUser(ws, analysis.clarifying_question);
      enrichedInput = `${userInput}. Additional context: ${answer}`;
      log(ws, `Clarified: ${answer}`, 'user');
    }

    sendState(ws, STATE.PLANNING);

    const scenarios = analysis.scenarios || [];

    // ── Check memory for ALL scenarios before calling LLM ────────────────────
    // Extracts module from the first scenario or from user input
    const guessedModule = scenarios[0]?.id?.split('_')[0]
      || userInput.toLowerCase().match(/(login|dashboard|project|profile)/)?.[0]
      || 'unknown';

    const memoryResults = scenarios.map(s => ({
      scenario: s,
      cached: findSimilarPlan(guessedModule, s.id),
    }));

    const uncachedScenarios = memoryResults.filter(r => !r.cached).map(r => r.scenario);
    const cachedCount = memoryResults.length - uncachedScenarios.length;

    if (cachedCount > 0) log(ws, `Memory hit: ${cachedCount} scenario(s) reused`, 'success');

    // ── Merged Call 2: generate steps for ALL uncached scenarios at once ──────
    // Cost: 1 LLM call instead of N calls
    let freshPlans = [];
    if (uncachedScenarios.length > 0) {
      log(ws, `Generating steps for ${uncachedScenarios.length} scenario(s)...`);
      const batchResult = await generateAllScenarioSteps(uncachedScenarios, docContext, browserContext);
      freshPlans = batchResult;
      log(ws, 'All plans generated', 'success');
    }

    // Build final plan map: scenarioId → plan
    const planMap = {};

    for (const { scenario, cached } of memoryResults) {
      if (cached) {
        planMap[scenario.id] = cached;
      } else {
        const fresh = freshPlans.find(p => p.id === scenario.id);
        if (fresh) {
          validatePlan(fresh);
          saveToMemory(fresh);
          planMap[scenario.id] = fresh;
        }
      }
    }

    // ── No scenarios — single specific request ────────────────────────────────
    if (scenarios.length === 0) {
      const cached = findSimilarPlan(guessedModule, userInput.toLowerCase().replace(/\s+/g, '_'));
      let plan = cached;

      if (!plan) {
        log(ws, 'Generating plan...');
        plan = await generateSteps(enrichedInput, docContext, browserContext);
        validatePlan(plan);
        saveToMemory(plan);
      } else {
        log(ws, 'Memory hit', 'success');
      }

      send(ws, 'scenario_start', { id: 'single', name: userInput, description: userInput });
      const { result, healCount } = await executePlan(ws, plan, 'single', enrichedInput);

      send(ws, 'report', {
        ...result, healCount,
        scenarios: [{ scenario: { id: 'single', name: userInput }, result, healCount }],
        summary: { total: 1, passed: result.status === 'success' ? 1 : 0, failed: result.status === 'failed' ? 1 : 0, healed: healCount }
      });
      sendState(ws, STATE.IDLE);
      return;
    }

    // ── Let user pick which scenarios to run ──────────────────────────────────
    send(ws, 'scenarios', { scenarios, module: userInput });
    const choice = await waitForAnswer(ws);
    send(ws, 'answer_received', choice);

    const scenariosToRun = choice.toLowerCase().includes('all')
      ? scenarios
      : (() => {
          const indices = [...choice.matchAll(/\d+/g)].map(m => parseInt(m[0]) - 1);
          return indices.length > 0
            ? indices.filter(i => i >= 0 && i < scenarios.length).map(i => scenarios[i])
            : scenarios;
        })();

    log(ws, `Running ${scenariosToRun.length} scenario(s)`);

    // ── Execute each scenario ─────────────────────────────────────────────────
    sendState(ws, STATE.EXECUTING);
    const scenarioResults = [];
    let totalHealed = 0;

    for (let i = 0; i < scenariosToRun.length; i++) {
      const scenario = scenariosToRun[i];
      const plan = planMap[scenario.id];

      if (!plan) {
        log(ws, `No plan found for "${scenario.name}" — skipping`, 'warn');
        continue;
      }

      send(ws, 'scenario_start', scenario);
      log(ws, `Running: ${scenario.name}`);

      const { result, healCount } = await executePlan(ws, plan, scenario.id, enrichedInput);
      scenarioResults.push({ scenario, result, healCount });
      totalHealed += healCount;

      if (i < scenariosToRun.length - 1) {
        await new Promise(r => setTimeout(r, 600));
        log(ws, '─────────────────────');
      }
    }

    const passed = scenarioResults.filter(r => r.result.status === 'success').length;
    const failed = scenarioResults.filter(r => r.result.status === 'failed').length;

    send(ws, 'report', {
      status: failed === 0 ? 'success' : 'failed',
      healCount: totalHealed,
      scenarios: scenarioResults,
      summary: { total: scenariosToRun.length, passed, failed, healed: totalHealed }
    });

    sendState(ws, STATE.IDLE);

  } catch (err) {
    log(ws, err.message, 'error');
    send(ws, 'error', err.message);
    sendState(ws, STATE.IDLE);
  }
}

// ── WebSocket ──────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('Client connected');
  sendState(ws, STATE.IDLE);
  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type !== 'prompt') return;
    orchestrate(ws, msg.data);
  });
  ws.on('close', () => console.log('Client disconnected'));
});

server.listen(4000, () => {
  console.log('QA Agent:  http://localhost:4000');
  console.log('Test app:  http://localhost:4000/testapp');
});