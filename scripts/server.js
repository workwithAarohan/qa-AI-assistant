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

app.get('/.well-known/appspecific/com.chrome.devtools.json', (req, res) => res.json({ name: 'com.chrome.devtools', version: 1 }));
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

function phase(ws, text) {
  // Phase separator — visually distinct from regular logs
  send(ws, 'log', { text, level: 'phase' });
}

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

function resolveSpecificScenario(input, docScenarios) {
  const lower = input.toLowerCase();
  function matchesWholeWord(text, word) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`).test(text);
  }
  const scored = docScenarios.map(s => {
    const raw = [...s.id.split('_'), ...s.name.toLowerCase().split(/\s+/)].filter(w => w.length > 2);
    const keywords = [...new Set(raw)];
    const matches = keywords.filter(kw => matchesWholeWord(lower, kw));
    return { scenario: s, score: matches.length };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);

  if (!scored.length) return null;
  const top = scored[0], second = scored[1];
  return (!second || top.score > second.score) && top.score >= 2 ? top.scenario : null;
}

// ── EXPLORE: conversational response about a module ───────────────────────────
function buildExploreResponse(docScenarios, docs, userInput) {
  const lower = userInput.toLowerCase();

  // Check if asking about a specific module
  const matchedDoc = docs.find(d => lower.includes(d.name.toLowerCase()));

  if (matchedDoc) {
    const scenarios = docScenarios.filter(s => s.module === matchedDoc.name);
    const urlMatch = matchedDoc.content.match(/##\s*URL\s*\n(https?:\/\/[^\s]+)/i);
    const url = urlMatch ? urlMatch[1] : null;

    let msg = `Here is what I know about the **${matchedDoc.name}** module:\n\n`;
    if (url) msg += `URL: ${url}\n\n`;

    const desc = matchedDoc.content.match(/##\s*Description\s*\n([\s\S]*?)(?=\n##|$)/i)?.[1]?.trim();
    if (desc) msg += `${desc}\n\n`;

    if (scenarios.length > 0) {
      msg += `Test scenarios available:\n${scenarios.map((s, i) => `${i + 1}. ${s.name} — ${s.description}`).join('\n')}\n\n`;
      msg += `Say "test ${matchedDoc.name}" to run all, or "test ${matchedDoc.name} with ${scenarios[0].name}" to run one.`;
    }
    return msg;
  }

  // Generic explore — list all modules
  const modules = [...new Set(docs.map(d => d.name))];
  return `I can test the following modules:\n${modules.map(m => `• ${m}`).join('\n')}\n\nAsk me about any module to learn more, or say "test [module name]" to run tests.`;
}

// ── Execute one plan — with countdown ────────────────────────────────────────

async function executePlan(ws, plan, scenarioId, userInput, baseUrl, browser) {
  const finalPlan = injectDocUrl(plan, baseUrl);
  send(ws, 'plan', { ...finalPlan, scenarioId });

  // 2-second countdown before execution
  log(ws, 'Starting in 2 seconds...', 'info');
  await new Promise(r => setTimeout(r, 1000));
  log(ws, 'Starting in 1 second...', 'info');
  await new Promise(r => setTimeout(r, 1000));

  sendState(ws, STATE.EXECUTING);
  phase(ws, '── Executing steps ──');

  let result = await runSteps(finalPlan.steps, {
    browser, baseUrl,
    onStep: (index, step, status) => send(ws, 'step', { index, status }),
    onLog:  (text, level) => log(ws, text, level),
  });

  let healCount = 0;

  if (result.status === 'failed') {
    phase(ws, '── Step failed ──');
    log(ws, `Failed: ${result.error}`, 'error');
    const choice = await askUser(ws, `A step failed: "${result.error}". What should I do?`, 'heal_choice');

    if (/yes|heal|try|fix|retry/i.test(choice)) {
      phase(ws, '── Auto-healing ──');
      log(ws, 'Refreshing browser context...', 'info');
      const freshCtx = await captureBrowserContext(baseUrl);
      log(ws, 'Asking Gemini for corrected plan...', 'info');
      const fixedPlan = await fixSteps(finalPlan, result.error, userInput, freshCtx);
      validatePlan(fixedPlan);
      const fixedWithUrl = injectDocUrl(fixedPlan, baseUrl);
      send(ws, 'plan', { ...fixedWithUrl, scenarioId });

      phase(ws, '── Retrying with healed plan ──');
      result = await runSteps(fixedWithUrl.steps, {
        browser, baseUrl,
        onStep: (index, step, status) => send(ws, 'step', { index, status }),
        onLog:  (text, level) => log(ws, text, level),
      });

      healCount++;
      if (result.status === 'success') {
        log(ws, 'Heal successful', 'success');
        phase(ws, '── Saving healed plan to memory ──');
        saveToMemory(fixedPlan);
        log(ws, 'Memory updated', 'success');
      } else {
        log(ws, 'Heal failed', 'error');
      }
    } else {
      log(ws, 'Stopped by user', 'warn');
    }
  } else {
    phase(ws, '── Saving to memory ──');
    saveToMemory(finalPlan);
    log(ws, 'Plan cached for future runs', 'success');
  }

  return { result, healCount };
}

// ── Router ────────────────────────────────────────────────────────────────────

const GREET_PHRASES = ['hi', 'hello', 'hey', 'help', 'what can you do', 'what do you do', 'who are you'];

function routeRequest(userInput, docScenarios) {
  const lower = userInput.toLowerCase().trim();
  if (GREET_PHRASES.some(p => lower === p || lower.startsWith(p + ' '))) return 'GREET';

  // Explore/understand intent keywords
  if (/\b(what|tell me|show me|explain|describe|about|how does|info|information|learn)\b/.test(lower)) return 'EXPLORE';

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

    // ── Phase 1: Load context from docs (zero LLM cost) ─────────────────────
    phase(ws, '── Loading context ──');
    log(ws, 'Reading documentation...', 'info');
    const docContext   = getRelevantContext(userInput);
    const baseUrl      = extractBaseUrl(userInput) || process.env.BASE_URL || 'http://localhost:4000/testapp';
    const docScenarios = extractDocScenarios(userInput);
    const allDocs      = loadAllDocs();
    const module       = docScenarios[0]?.module || 'general';

    if (docContext) log(ws, `Docs loaded: ${docScenarios[0]?.module || 'general'}`, 'success');
    else log(ws, 'No matching docs found', 'warn');

    const route = routeRequest(userInput, docScenarios);

    // ── Route A: Greet ───────────────────────────────────────────────────────
    if (route === 'GREET') {
      const modules = [...new Set(allDocs.map(d => d.name))];
      const msg = `Hi! I am your QA automation agent.\n\nI can test these modules:\n${modules.map(m => `• ${m}`).join('\n')}\n\nYou can:\n• Ask me about any module — "tell me about login"\n• Run a specific test — "test login with invalid password"\n• Run all scenarios — "test login"\n\nWhat would you like to do?`;
      send(ws, 'agent_message', msg);
      return;
    }

    // ── Route: Explore/understand ────────────────────────────────────────────
    if (route === 'EXPLORE') {
      const msg = buildExploreResponse(docScenarios, allDocs, userInput);
      send(ws, 'agent_message', msg);
      return;
    }

    // ── Route B: Specific single scenario ────────────────────────────────────
    if (route?.route === 'SPECIFIC') {
      const s = route.scenario;
      log(ws, `Matched: "${s.name}"`, 'success');
      log(ws, `URL: ${baseUrl}`, 'info');
      send(ws, 'scenario_start', s);

      phase(ws, '── Checking memory ──');
      const cached = findSimilarPlan(s.module, s.id, userInput);
      let plan = cached;

      if (cached) {
        log(ws, `Memory hit — reusing cached plan for "${s.name}"`, 'success');
        log(ws, `Plan has ${cached.steps?.length || 0} steps`, 'info');
      } else {
        log(ws, 'No cached plan found — generating via Gemini', 'info');
        phase(ws, '── Capturing browser state ──');
        const browserCtx = await captureBrowserContext(baseUrl);
        log(ws, `DOM snapshot: ${browserCtx.split('\n').length} elements captured`, 'info');

        phase(ws, '── Generating test plan ──');
        log(ws, 'Calling Gemini...', 'info');
        const batch = await generateAllScenarioSteps([s], docContext, browserCtx);
        plan = batch[0];
        validatePlan(plan);
        log(ws, `Plan generated: ${plan.steps?.length || 0} steps`, 'success');
        phase(ws, '── Saving to memory ──');
        saveToMemory(plan);
        log(ws, `Saved as "${plan.module}__${plan.scenario}"`, 'success');
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

    // ── Route C: Module-level ─────────────────────────────────────────────────
    if (route === 'MODULE') {
      phase(ws, '── Checking memory ──');
      const memoryCheck = docScenarios.map(s => ({ scenario: s, cached: findSimilarPlan(module, s.id, userInput) }));
      const cachedCount = memoryCheck.filter(r => r.cached).length;
      const uncachedScenarios = memoryCheck.filter(r => !r.cached).map(r => r.scenario);

      log(ws, `${cachedCount} of ${docScenarios.length} scenarios in memory`, cachedCount === docScenarios.length ? 'success' : 'info');

      if (uncachedScenarios.length > 0) {
        phase(ws, '── Capturing browser state ──');
        const browserCtx = await captureBrowserContext(baseUrl);
        log(ws, `DOM captured at ${baseUrl}`, 'info');

        phase(ws, '── Generating missing plans ──');
        log(ws, `Generating steps for: ${uncachedScenarios.map(s => s.name).join(', ')}`, 'info');
        const batch = await generateAllScenarioSteps(uncachedScenarios, docContext, browserCtx);
        batch.forEach(p => {
          validatePlan(p); saveToMemory(p);
          log(ws, `Saved: "${p.module}__${p.scenario}"`, 'success');
          const m = memoryCheck.find(r => r.scenario.id === p.id);
          if (m) m.cached = p;
        });
      }

      sendState(ws, STATE.PLANNING);
      send(ws, 'scenarios', { scenarios: docScenarios, module: userInput });
      const choice = await waitForAnswer(ws);
      send(ws, 'answer_received', choice);

      const toRun = choice.toLowerCase().includes('all')
        ? docScenarios
        : (() => {
            const indices = [...choice.matchAll(/\d+/g)].map(m => parseInt(m[0]) - 1);
            return indices.length > 0 ? indices.filter(i => i >= 0 && i < docScenarios.length).map(i => docScenarios[i]) : docScenarios;
          })();

      sendState(ws, STATE.EXECUTING);
      browserInstance = await chromium.launch({ headless: false });
      const scenarioResults = [];
      let totalHealed = 0;

      for (let i = 0; i < toRun.length; i++) {
        const s = toRun[i];
        const plan = memoryCheck.find(r => r.scenario.id === s.id)?.cached;
        if (!plan) { log(ws, `No plan for "${s.name}" — skipping`, 'warn'); continue; }

        phase(ws, `── Scenario ${i + 1}/${toRun.length}: ${s.name} ──`);
        send(ws, 'scenario_start', s);
        const { result, healCount } = await executePlan(ws, plan, s.id, userInput, baseUrl, browserInstance);
        scenarioResults.push({ scenario: s, result, healCount });
        totalHealed += healCount;

        if (i < toRun.length - 1) await new Promise(r => setTimeout(r, 400));
      }

      const passed = scenarioResults.filter(r => r.result.status === 'success').length;
      const failed = scenarioResults.filter(r => r.result.status === 'failed').length;
      send(ws, 'report', { status: failed === 0 ? 'success' : 'failed', healCount: totalHealed, scenarios: scenarioResults, summary: { total: toRun.length, passed, failed, healed: totalHealed } });
      sendState(ws, STATE.IDLE);
      return;
    }

    // ── Route D: Unknown — LLM analysis ──────────────────────────────────────
    phase(ws, '── Analyzing request ──');
    log(ws, 'Capturing browser state...', 'info');
    const browserCtx = await captureBrowserContext(baseUrl);
    log(ws, 'DOM captured', 'info');

    const { enrichedInput } = await gatherContext(userInput, null, (q) => askUser(ws, q), (t, l) => log(ws, t, l));

    log(ws, 'Sending to Gemini for analysis...', 'info');
    const analysis = await analyzeRequest(enrichedInput, docContext, browserCtx);
    send(ws, 'intent', { intent: analysis.intent, confidence: 'high' });
    log(ws, `Intent classified: ${analysis.intent}`, 'info');

    if (analysis.intent === 'OUT_OF_SCOPE') { send(ws, 'agent_message', outOfScopeResponse(userInput)); return; }
    if (analysis.intent === 'EXPLORE' || analysis.intent === 'UNDERSTAND') {
      send(ws, 'agent_message', buildExploreResponse(docScenarios, allDocs, userInput));
      return;
    }

    const scenarios = docScenarios.length > 0 ? docScenarios : (analysis.scenarios || []);
    if (!scenarios.length) { send(ws, 'agent_message', 'Could not identify test scenarios. Try being more specific.'); return; }

    sendState(ws, STATE.PLANNING);
    const planMap = {};
    const stillUncached = scenarios.filter(s => { const p = findSimilarPlan(module, s.id); if (p) { planMap[s.id] = p; return false; } return true; });
    if (stillUncached.length > 0) {
      const batch = await generateAllScenarioSteps(stillUncached, docContext, browserCtx);
      batch.forEach(p => { validatePlan(p); saveToMemory(p); planMap[p.id] = p; log(ws, `Saved: "${p.module}__${p.scenario}"`, 'success'); });
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
      phase(ws, `── Scenario ${i + 1}/${finalToRun.length}: ${s.name} ──`);
      send(ws, 'scenario_start', s);
      const { result, healCount } = await executePlan(ws, planMap[s.id], s.id, enrichedInput, baseUrl, browserInstance);
      results.push({ scenario: s, result, healCount }); healed += healCount;
      if (i < finalToRun.length - 1) await new Promise(r => setTimeout(r, 400));
    }
    const p = results.filter(r => r.result.status === 'success').length;
    const f = results.filter(r => r.result.status === 'failed').length;
    send(ws, 'report', { status: f === 0 ? 'success' : 'failed', healCount: healed, scenarios: results, summary: { total: finalToRun.length, passed: p, failed: f, healed } });
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

// ── WebSocket ──────────────────────────────────────────────────────────────────
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