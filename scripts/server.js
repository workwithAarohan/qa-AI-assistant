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
import { saveToMemory, findSimilarPlan } from './memory.js';
import { getRelevantContext, extractBaseUrl, extractDocScenarios, loadAllDocs } from './context.js';
import { captureBrowserContext } from './browser-context.js';
import { guardCheck } from './guard.js';
import { STATE, outOfScopeResponse } from './classifier.js';

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function send(ws, type, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type, data }));
}

function log(ws, text, level = 'info') {
  console.log(`[${level.toUpperCase()}] ${text}`);
  send(ws, 'log', { text, level });
}

function sendState(ws, state) { send(ws, 'agent_state', state); }

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

// ── Inject URL into plan steps from docs ─────────────────────────────────────
// Replaces any placeholder or wrong URL in navigate steps
// with the authoritative URL extracted from the markdown doc.

function injectDocUrl(plan, baseUrl) {
  if (!baseUrl || !plan?.steps) return plan;
  return {
    ...plan,
    steps: plan.steps.map(step => {
      if (step.action === 'navigate' && step.value) {
        // Only replace if it looks like a relative path or wrong base
        const isRelative = !step.value.startsWith('http');
        const isWrongBase = step.value.startsWith('http') && !step.value.includes(baseUrl.split('/testapp')[0]);
        if (isRelative) {
          return { ...step, value: baseUrl + (step.value.startsWith('/') ? step.value : '/' + step.value) };
        }
        // If step.value is just the base or a sub-path, keep it
        return step;
      }
      return step;
    }),
  };
}

// ── Execute one plan ──────────────────────────────────────────────────────────

async function executePlan(ws, plan, scenarioId, userInput, baseUrl) {
  const finalPlan = injectDocUrl(plan, baseUrl);
  send(ws, 'plan', { ...finalPlan, scenarioId });
  sendState(ws, STATE.EXECUTING);

  const result = await runSteps(plan.steps, {
    browser,
    baseUrl,
    onStep: (index, step, status) => send(ws, 'step', { index, status }),
    onLog: (text, level) => send(ws, 'log', { text, level })
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

      result = await runSteps(plan.steps, {
        browser,
        baseUrl,
        onStep: (index, step, status) => send(ws, 'step', { index, status }),
        onLog: (text, level) => send(ws, 'log', { text, level })
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
  try {

    // ── Layer 2: Guard ───────────────────────────────────────────────────────
    const guard = guardCheck(userInput);
    if (!guard.safe) {
      send(ws, 'agent_message', guard.reason);
      send(ws, 'report', { status: 'blocked', results: [], healCount: 0, summary: { total: 0, passed: 0, failed: 0, healed: 0 } });
      return;
    }

    // Inside orchestrate(ws, userInput)
    const lowInput = userInput.toLowerCase().trim();

    // Optimization: Immediate local responses for common short phrases
    if (['hi', 'hello', 'hey', 'help', 'what do you do?'].includes(lowInput)) {
      const helpMsg = "I'm your QA Assistant! I can:\n1. **Run tests** (e.g., 'test login')\n2. **Explore** (e.g., 'what can I test?')\n3. **Heal** failing scripts automatically.";
      send(ws, 'agent_message', helpMsg);
      return;
    }

    if (lowInput.length < 3) {
      send(ws, 'agent_message', "Could you provide a bit more detail? For example: 'Test the login page'.");
      return;
    }

    sendState(ws, STATE.GATHERING_CONTEXT);

    // ── Load doc context + extract URL from docs (no LLM) ───────────────────
    log(ws, 'Searching documentation...', 'info');
    const docContext = getRelevantContext(userInput);
    let baseUrl    = extractBaseUrl(userInput);
    if (!baseUrl) {
      const urlMatch = userInput.match(/https?:\/\/[^\s]+/);
      if (urlMatch) {
        baseUrl = urlMatch[0];
        log(ws, `Using URL from prompt: ${baseUrl}`, 'info');
      }
    }

    // 3. FINAL FALLBACK: If still no URL, ask the user
    if (!baseUrl) {
      log(ws, "I don't know which website to test.", 'warn');
      baseUrl = await askUser(ws, "I couldn't find a URL in my docs. Which URL should I test?");
      // Basic validation
      if (!baseUrl.startsWith('http')) baseUrl = 'http://' + baseUrl;
    }

    const docScenarios = extractDocScenarios(userInput); // scenarios from docs

    if (docContext) log(ws, 'Docs loaded', 'success');
    if (baseUrl)    log(ws, `Base URL: ${baseUrl}`, 'success');

    // ── Check memory using doc-declared scenarios ────────────────────────────
    // 1. Try to get the module name from the first documented scenario found
    let module = docScenarios[0]?.module;

    // 2. FALLBACK: If no docs, try to get it from the browser page title or URL
    if (!module && browserContext) {
      try {
        const dom = JSON.parse(browserContext);
        // Look for a heading or a specific ID that might indicate the module
        const mainHeader = dom.find(el => el.tag === 'h1')?.text;
        if (mainHeader) {
          module = mainHeader.toLowerCase().replace(/\s+/g, '_');
        }
      } catch (e) {
        module = 'default_module';
      }
    }

    // 3. LAST RESORT: Just use "general" or a slug from the URL
    if (!module) {
      module = baseUrl ? new URL(baseUrl).pathname.replace(/\//g, '') || 'index' : 'unknown';
    }

    const memoryCheck = docScenarios.map(s => ({
      scenario: s,
      cached: findSimilarPlan(module, s.id, userInput),
    }));

    const allCached   = memoryCheck.length > 0 && memoryCheck.every(r => r.cached);
    const noneCached  = memoryCheck.every(r => !r.cached);

    if (allCached) {
      // ── ZERO LLM CALLS — everything from memory ──────────────────────────
      log(ws, `Full memory hit — all ${memoryCheck.length} scenarios cached`, 'success');
      send(ws, 'scenarios', { scenarios: docScenarios, module: userInput });

      const choice = await waitForAnswer(ws);
      send(ws, 'answer_received', choice);

      const scenariosToRun = choice.toLowerCase().includes('all')
        ? docScenarios
        : (() => {
            const indices = [...choice.matchAll(/\d+/g)].map(m => parseInt(m[0]) - 1);
            return indices.length > 0
              ? indices.filter(i => i >= 0 && i < docScenarios.length).map(i => docScenarios[i])
              : docScenarios;
          })();

      sendState(ws, STATE.EXECUTING);
      const scenarioResults = [];
      let totalHealed = 0;

      for (let i = 0; i < scenariosToRun.length; i++) {
        const s = scenariosToRun[i];
        const plan = memoryCheck.find(r => r.scenario.id === s.id)?.cached;
        if (!plan) continue;

        send(ws, 'scenario_start', s);
        log(ws, `Running (cached): ${s.name}`);

        const { result, healCount } = await executePlan(ws, plan, s.id, userInput, baseUrl);
        scenarioResults.push({ scenario: s, result, healCount });
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
      return;
    }

    // ── Need LLM — capture browser context now ───────────────────────────────
    log(ws, 'Connecting to browser...', 'info');
    const browserContext = await captureBrowserContext(baseUrl || undefined);
    log(ws, 'DOM captured', 'success');

    // ── MERGED CALL 1: analyze + scenarios (1 LLM call) ─────────────────────
    log(ws, 'Synthesizing DOM + Docs...', 'info');
    const analysis = await analyzeRequest(userInput, docContext, browserContext);
    log(ws, `Intent: ${analysis.intent}`, 'info');
    send(ws, 'intent', { intent: analysis.intent, confidence: 'high' });

    if (analysis.intent === 'OUT_OF_SCOPE') {
      send(ws, 'agent_message', outOfScopeResponse(userInput));
      send(ws, 'report', { status: 'out_of_scope', results: [], healCount: 0, summary: { total: 0, passed: 0, failed: 0, healed: 0 } });
      return;
    }

    if (analysis.intent === 'EXPLORE' || analysis.intent === 'UNDERSTAND') {
      // Extract unique module names from the documented scenarios
      const uniqueModules = [...new Set(docScenarios.map(s => s.module))];
      
      let message = "I can help with that! Based on my documentation, you can test the following modules:\n";
      if (uniqueModules.length > 0) {
        message += uniqueModules.map(m => `• ${m}`).join('\n');
      } else {
        message += "• Login\n• Dashboard\n• Projects"; // Fallback
      }
      message += "\n\nJust tell me which one you want to run (e.g., 'test the login module').";

      send(ws, 'agent_message', message);
      send(ws, 'report', { status: 'success', results: [], healCount: 0, summary: { total: 0, passed: 0, failed: 0, healed: 0 } });
      return;
    }

    // Clarify if needed
    let enrichedInput = userInput;
    if (!analysis.ready && analysis.clarifying_question) {
      const answer = await askUser(ws, analysis.clarifying_question);
      enrichedInput = `${userInput}. Additional context: ${answer}`;
    }

    sendState(ws, STATE.PLANNING);

    // Prefer doc scenarios over LLM-discovered ones — they are authoritative
    const scenarios = docScenarios.length > 0 ? docScenarios : (analysis.scenarios || []);

    // ── Check which scenarios still need plans ───────────────────────────────
    const planMap = {};

    const stillUncached = scenarios.filter(s => {
      const cached = findSimilarPlan(module, s.id);
      if (cached) { planMap[s.id] = cached; return false; }
      return true;
    });

    if (Object.keys(planMap).length > 0) {
      log(ws, `${Object.keys(planMap).length} scenario(s) from memory`, 'success');
    }

    // ── MERGED CALL 2: all uncached scenarios in one batch ───────────────────
    if (stillUncached.length > 0) {
      log(ws, `Generating steps for ${stillUncached.length} scenario(s)...`);
      const batchPlans = await generateAllScenarioSteps(stillUncached, docContext, browserContext);

      for (const plan of batchPlans) {
        validatePlan(plan);
        saveToMemory(plan);
        planMap[plan.id] = plan;
      }
      log(ws, 'All plans generated and cached', 'success');
    }

    // ── Show scenarios to user ───────────────────────────────────────────────
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

    // ── Execute ──────────────────────────────────────────────────────────────
    sendState(ws, STATE.EXECUTING);
    const scenarioResults = [];
    let totalHealed = 0;

    for (let i = 0; i < scenariosToRun.length; i++) {
      const s = scenariosToRun[i];
      const plan = planMap[s.id];

      if (!plan) {
        log(ws, `No plan for "${s.name}" — skipping`, 'warn');
        continue;
      }

      send(ws, 'scenario_start', s);
      log(ws, `Running: ${s.name}`);

      const { result, healCount } = await executePlan(ws, plan, s.id, enrichedInput, baseUrl);
      scenarioResults.push({ scenario: s, result, healCount });
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
  const docs = loadAllDocs(); // Your function that reads the /docs directory
  
  const suggestions = docs.length > 0 
    ? docs.slice(0, 3).map(d => `Test ${d.name.replace('.md', '')}`)
    : ["Explore the app", "Run health check"];

  // 2. Send them immediately to the UI
  ws.send(JSON.stringify({ 
    type: 'suggestions', 
    data: { payload: suggestions } 
  }));

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