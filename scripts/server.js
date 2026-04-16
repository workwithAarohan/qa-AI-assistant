import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { chromium } from 'playwright'; // ✅ Added for browser management

dotenv.config();

import { analyzeRequest, generateAllScenarioSteps, generateSteps, fixSteps } from './agent.js';
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

// ── Middleware & CSP ─────────────────────────────────────────────────────────

app.use((req, res, next) => {
  const csp = [
    "default-src 'self'",
    "connect-src 'self' ws: http://localhost:4000",
    "script-src 'self' https://cdn.tailwindcss.com 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
  ].join('; ');
  res.setHeader('Content-Security-Policy', csp);
  next();
});

app.get('/.well-known/appspecific/com.chrome.devtools.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  return res.json({ name: 'com.chrome.devtools', description: 'Local DevTools app manifest', version: 1 });
});

app.use(express.static(ROOT));
app.use('/testapp', express.static(path.join(ROOT, 'public', 'testapp')));
app.get(/^\/testapp\/?.*$/, (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'testapp.html'));
});
app.use('/dashboard', express.static(path.join(ROOT, 'public', 'dashboard')));
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'dashboard.html'));
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function send(ws, type, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type, data }));
}

function log(ws, text, level = 'info') {
  // ✅ FIX: The Gap Fix (Ignore empty/whitespace logs)
  if (!text || text.trim() === '') return;
  console.log(`[${level.toUpperCase()}] ${text}`);
  send(ws, 'log', { text, level });
}

function sendState(ws, state) { send(ws, 'agent_state', state); }

function waitForAnswer(ws, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Answer timeout')), timeoutMs);
    const handler = (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'answer') {
          clearTimeout(timer);
          ws.off('message', handler);
          resolve(msg.data);
        }
      } catch (err) { /* ignore parse errors */ }
    };
    ws.on('message', handler);
  });
}

async function askUser(ws, question) {
  send(ws, 'question', question);
  const answer = await waitForAnswer(ws);
  send(ws, 'answer_received', answer);
  return answer;
}

function injectDocUrl(plan, baseUrl) {
  if (!baseUrl || !plan?.steps) return plan;
  return {
    ...plan,
    steps: plan.steps.map(step => {
      if (step.action === 'navigate' && step.value) {
        const isRelative = !step.value.startsWith('http');
        const isWrongBase = step.value.startsWith('http') && !step.value.includes(baseUrl.split('/testapp')[0]);
        if (isRelative) {
          return { ...step, value: baseUrl + (step.value.startsWith('/') ? step.value : '/' + step.value) };
        }
        return step;
      }
      return step;
    }),
  };
}

// ── Execute one plan ──────────────────────────────────────────────────────────

// FIX: Accepts the browser instance passed from orchestrate
async function executePlan(ws, plan, scenarioId, userInput, baseUrl, browser) {
  const finalPlan = injectDocUrl(plan, baseUrl);
  send(ws, 'plan', { ...finalPlan, scenarioId });
  sendState(ws, STATE.EXECUTING);

  // FIX: Passing the shared browser instance to runSteps
  let result = await runSteps(finalPlan.steps, {
    browser,
    baseUrl,
    onStep: (index, step, status) => send(ws, 'step', { index, status }),
    onLog: (text, level) => log(ws, text, level)
  });

  let healCount = 0;

  if (result.status === 'failed') {
    log(ws, `Step failed: ${result.error}`, 'error');
    const choice = await askUser(ws, `Step failed: "${result.error}". Auto-heal or stop?`);

    if (/yes|heal|try|fix|retry/i.test(choice)) {
      log(ws, 'Auto-healing — refreshing DOM...', 'warn');
      const freshCtx = await captureBrowserContext(baseUrl);
      const fixedPlan = await fixSteps(finalPlan, result.error, userInput, freshCtx);
      validatePlan(fixedPlan);
      const fixedWithUrl = injectDocUrl(fixedPlan, baseUrl);
      send(ws, 'plan', { ...fixedWithUrl, scenarioId });

      // Retry with same browser instance
      result = await runSteps(fixedWithUrl.steps, {
        browser,
        baseUrl,
        onStep: (index, step, status) => send(ws, 'step', { index, status }),
        onLog: (text, level) => log(ws, text, level)
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
    saveToMemory(finalPlan);
    log(ws, 'Passed', 'success');
  }

  return { result, healCount };
}

// ── MAIN ORCHESTRATION ────────────────────────────────────────────────────────

async function orchestrate(ws, userInput) {
  let browserInstance = null;

  try {
    const guard = guardCheck(userInput);
    if (!guard.safe) {
      send(ws, 'agent_message', guard.reason);
      return;
    }

    const lowInput = userInput.toLowerCase().trim();
    if (['hi', 'hello', 'hey', 'help'].includes(lowInput)) {
      send(ws, 'agent_message', "I'm your QA Assistant! Tell me what to test.");
      return;
    }

    sendState(ws, STATE.GATHERING_CONTEXT);
    
    // 1. Context & authoritative scenarios from docs
    const docContext = getRelevantContext(userInput);
    let baseUrl = extractBaseUrl(userInput) || 'http://localhost:4000/testapp';
    const docScenarios = extractDocScenarios(userInput);
    let module = docScenarios[0]?.module || 'general';

    // 2. 🔥 FAST TRACK: Check for direct command in user input
    // If user says "Test login", and we have a scenario named "login"
    const directScenario = docScenarios.find(s => 
      lowInput.includes(s.name.toLowerCase()) || lowInput.includes(s.id.toLowerCase())
    );

    if (directScenario) {
      const cached = findSimilarPlan(module, directScenario.id, lowInput);
      if (cached) {
        log(ws, `Direct match for "${directScenario.name}" found in memory. Executing...`, 'success');
        browserInstance = await chromium.launch({ headless: false });
        await executePlan(ws, cached, directScenario.id, userInput, baseUrl, browserInstance);
        send(ws, 'report', { status: 'success', summary: { total: 1, passed: 1, failed: 0, healed: 0 } });
        sendState(ws, STATE.IDLE);
        return; // EXIT EARLY - No LLM used
      }
    }

    // 3. MEMORY CHECK: Are ALL documented scenarios already cached?
    const memoryCheck = docScenarios.map(s => ({
      scenario: s,
      cached: findSimilarPlan(module, s.id, lowInput),
    }));

    const allCached = memoryCheck.length > 0 && memoryCheck.every(r => r.cached);

    if (allCached) {
      log(ws, `Full memory hit for ${module}. Listing scenarios...`, 'success');
      send(ws, 'scenarios', { scenarios: docScenarios, module: userInput });
      const choice = await waitForAnswer(ws);
      
      const toRun = choice.toLowerCase().includes('all') 
        ? docScenarios 
        : docScenarios.filter((_, i) => choice.includes(i + 1));

      browserInstance = await chromium.launch({ headless: false });
      for (const s of toRun) {
        const plan = memoryCheck.find(r => r.scenario.id === s.id).cached;
        await executePlan(ws, plan, s.id, userInput, baseUrl, browserInstance);
      }
      sendState(ws, STATE.IDLE);
      return;
    }

    // 4. LLM FALLBACK: Only if we don't know what to do yet
    log(ws, 'No direct match. Capturing DOM for AI analysis...', 'info');
    const browserContext = await captureBrowserContext(baseUrl);
    const { enrichedInput } = await gatherContext(userInput, null, (q) => askUser(ws, q), (t, l) => log(ws, t, l));
    
    const analysis = await analyzeRequest(enrichedInput, docContext, browserContext);
    if (analysis.intent === 'OUT_OF_SCOPE') {
       send(ws, 'agent_message', outOfScopeResponse(userInput));
       return;
    }

    sendState(ws, STATE.PLANNING);
    // Prefer doc scenarios, fallback to LLM suggested ones
    const scenarios = docScenarios.length > 0 ? docScenarios : (analysis.scenarios || []);
    const planMap = {};

    // Generate plans for uncached scenarios
    const uncached = scenarios.filter(s => {
      const p = findSimilarPlan(module, s.id);
      if (p) { planMap[s.id] = p; return false; }
      return true;
    });

    if (uncached.length > 0) {
      log(ws, `Generating steps for ${uncached.length} scenario(s)...`);
      const batch = await generateAllScenarioSteps(uncached, docContext, browserContext);
      batch.forEach(p => { saveToMemory(p); planMap[p.id] = p; });
    }

    send(ws, 'scenarios', { scenarios, module: userInput });
    const finalChoice = await waitForAnswer(ws);
    const finalToRun = finalChoice.toLowerCase().includes('all') 
      ? scenarios 
      : scenarios.filter((_, i) => finalChoice.includes(i + 1));

    browserInstance = await chromium.launch({ headless: false });
    for (const s of finalToRun) {
      await executePlan(ws, planMap[s.id], s.id, enrichedInput, baseUrl, browserInstance);
    }

    sendState(ws, STATE.IDLE);
  } catch (err) {
    log(ws, err.message, 'error');
  } finally {
    if (browserInstance) await browserInstance.close();
    sendState(ws, STATE.IDLE);
  }
}

// ── WebSocket ──────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('Client connected');
  sendState(ws, STATE.IDLE);
  const docs = loadAllDocs();
  
  const suggestions = docs.length > 0 
    ? docs.slice(0, 3).map(d => `Test ${d.name.replace('.md', '')}`)
    : ["Explore the app", "Run health check"];

  ws.send(JSON.stringify({ type: 'suggestions', data: { payload: suggestions } }));

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'prompt') orchestrate(ws, msg.data);
  });
  
  ws.on('close', () => console.log('Client disconnected'));
});

server.listen(4000, () => {
  console.log('QA Agent: http://localhost:4000');
  console.log('Test App: http://localhost:4000/testapp');
});