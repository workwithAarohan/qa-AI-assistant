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

// ── FIX 1: Require score >= 2 to resolve SPECIFIC — prevents 'test login' → valid_login ──
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
  // FIX: require score >= 2 AND clear winner — 'test login' scores 1 → MODULE not SPECIFIC
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
    let msg = `Here is what I know about the ${matchedDoc.name} module:\n\n`;
    if (urlMatch) msg += `URL: ${urlMatch[1]}\n\n`;
    if (desc) msg += `${desc}\n\n`;
    if (scenarios.length > 0) {
      msg += `Test scenarios available:\n${scenarios.map((s, i) => `${i+1}. ${s.name} — ${s.description}`).join('\n')}\n\n`;
      msg += `Say "test ${matchedDoc.name}" to run all, or pick a specific one.`;
    }
    return msg;
  }
  const modules = [...new Set(docs.map(d => d.name))];
  return `I can test these modules:\n${modules.map(m => `• ${m}`).join('\n')}\n\nAsk me about any one to learn more, or say "test [module name]" to run tests.`;
}

// ── FIX 2: Confirmation sends plan steps to UI before asking ──────────────────
async function confirmExecution(ws, scenario, plan) {
  // Send the plan first so the test plan panel fills in
  const finalPlan = { ...plan, scenarioId: scenario.id };
  send(ws, 'plan', finalPlan);

  // Build a clean human-readable step summary (no IDs)
  const stepLines = plan.steps.slice(0, 6).map((s, i) => {
    const target = s.selector || s.value || '';
    const label  = {
      navigate:          `Navigate to ${target}`,
      type:              `Type "${s.value}" into ${s.selector}`,
      click:             `Click ${s.selector}`,
      expect:            `Expect ${s.selector} to be visible`,
      expecturl:         `Expect URL to contain ${s.value}`,
      waitfornavigation: `Wait for page to load`,
      asserttext:        `Verify text "${s.value}" in ${s.selector}`,
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

// ── Execute one plan ──────────────────────────────────────────────────────────
async function executePlan(ws, plan, scenario, userInput, baseUrl, browser) {
  const finalPlan = injectDocUrl(plan, baseUrl);
  // Re-send plan with injected URLs (may differ from what was shown in confirm)
  send(ws, 'plan', { ...finalPlan, scenarioId: scenario.id });
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
    log(ws, `Error: ${result.error}`, 'error');
    send(ws, 'question', {
      text: result.error,
      type: 'heal_choice',
      meta: {
        failedStep: result.results?.find(r => r.status === 'failed')?.step,
        error: result.error,
      },
    });
    const choice = await waitForAnswer(ws);

    if (/yes|heal|try|fix|retry/i.test(choice)) {
      phase(ws, '── Auto-healing ──');
      log(ws, 'Capturing fresh browser snapshot...', 'info');
      const freshCtx = await captureBrowserContext(baseUrl);
      log(ws, 'Asking Gemini for corrected steps...', 'info');
      const fixedPlan = await fixSteps(finalPlan, result.error, userInput, freshCtx);
      validatePlan(fixedPlan);
      const fixedWithUrl = injectDocUrl(fixedPlan, baseUrl);
      send(ws, 'plan', { ...fixedWithUrl, scenarioId: scenario.id });
      phase(ws, '── Retrying healed plan ──');
      result = await runSteps(fixedWithUrl.steps, {
        browser, baseUrl,
        onStep: (index, step, status) => send(ws, 'step', { index, status }),
        onLog:  (text, level) => log(ws, text, level),
      });
      healCount++;
      if (result.status === 'success') {
        log(ws, 'Heal succeeded', 'success');
        phase(ws, '── Saving healed plan ──');
        saveToMemory(fixedPlan);
        log(ws, `Cached: "${fixedPlan.module}__${fixedPlan.scenario}"`, 'success');
      } else {
        log(ws, 'Heal also failed', 'error');
      }
    } else {
      log(ws, 'Stopped by user', 'warn');
    }
  } else {
    phase(ws, '── Saving to memory ──');
    saveToMemory(finalPlan);
    log(ws, `Cached: "${finalPlan.module}__${finalPlan.scenario}"`, 'success');
  }

  return { result, healCount };
}

// ── Router ────────────────────────────────────────────────────────────────────
const GREET_PHRASES = ['hi', 'hello', 'hey', 'help', 'what can you do', 'what do you do', 'who are you'];

function routeRequest(userInput, docScenarios) {
  const lower = userInput.toLowerCase().trim();
  if (GREET_PHRASES.some(p => lower === p || lower.startsWith(p + ' '))) return 'GREET';
  if (/\b(what|tell me|show me|explain|describe|about|how does|info|information|learn)\b/.test(lower)) return 'EXPLORE';
  const specific = resolveSpecificScenario(lower, docScenarios);
  if (specific) return { route: 'SPECIFIC', scenario: specific };
  if (docScenarios.length > 0) return 'MODULE';
  return 'ANALYZE';
}

// ── Shared scenario runner ────────────────────────────────────────────────────
async function runScenarios(ws, toRun, getPlan, userInput, baseUrl, browserInstance, confirmEach = true) {
  const scenarioResults = [];
  let totalHealed = 0;

  for (let i = 0; i < toRun.length; i++) {
    const s = toRun[i];
    const plan = typeof getPlan === 'function' ? getPlan(s) : getPlan.find(r => r.scenario.id === s.id)?.cached;

    if (!plan) { log(ws, `No plan for "${s.name}" — skipping`, 'warn'); continue; }

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

    const { result, healCount } = await executePlan(ws, plan, s, userInput, baseUrl, browserInstance);
    scenarioResults.push({ scenario: s, result, healCount });
    totalHealed += healCount;

    if (i < toRun.length - 1) await new Promise(r => setTimeout(r, 400));
  }

  return { scenarioResults, totalHealed };
}

// ── MAIN ORCHESTRATION ────────────────────────────────────────────────────────
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

    // ── Route A: Greet ────────────────────────────────────────────────────────
    if (route === 'GREET') {
      const modules = [...new Set(allDocs.map(d => d.name))];
      send(ws, 'agent_message', `Hi! I am your QA automation agent.\n\nI can test these modules:\n${modules.map(m => `• ${m}`).join('\n')}\n\nYou can:\n• Ask about a module — "tell me about login"\n• Run one test — "test login with invalid password"\n• Run all scenarios — "test login"\n• Run regression — "run regression"\n\nWhat would you like to do?`);
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
      if (!/yes|run|ok|confirm|go|start|all/i.test(choice)) { send(ws, 'agent_message', 'Regression cancelled.'); sendState(ws, STATE.IDLE); return; }
      sendState(ws, STATE.EXECUTING);
      browserInstance = await chromium.launch({ headless: false });
      const { scenarioResults, totalHealed } = await runScenarios(ws, allScenarios, (s) => memoryCheck.find(r => r.scenario.id === s.id && r.scenario.module === s.module)?.cached, userInput, baseUrl, browserInstance, false);
      const passed = scenarioResults.filter(r => r.result.status === 'success').length;
      const failed = scenarioResults.filter(r => r.result.status === 'failed').length;
      const skipped = scenarioResults.filter(r => r.result.status === 'skipped').length;
      send(ws, 'report', { type: 'regression', status: failed === 0 ? 'success' : 'failed', healCount: totalHealed, scenarios: scenarioResults, summary: { total: allScenarios.length, passed, failed, skipped, healed: totalHealed } });
      sendState(ws, STATE.IDLE);
      return;
    }

    // ── Route B: Specific ─────────────────────────────────────────────────────
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
        log(ws, 'Cache miss — generating via Gemini', 'info');
        phase(ws, '── Capturing browser state ──');
        const browserCtx = await captureBrowserContext(baseUrl);
        log(ws, `DOM captured: ${browserCtx.split('\n').length} lines`, 'info');
        phase(ws, '── Generating test plan ──');
        log(ws, 'Calling Gemini...', 'info');
        const batch = await generateAllScenarioSteps([s], docContext, browserCtx);
        plan = batch[0];
        validatePlan(plan);
        log(ws, `Plan ready: ${plan.steps?.length} steps`, 'success');
        phase(ws, '── Saving to memory ──');
        saveToMemory(plan);
        log(ws, `Saved: "${plan.module}__${plan.scenario}"`, 'success');
      }
      const confirmed = await confirmExecution(ws, s, plan);
      if (!confirmed) { send(ws, 'agent_message', 'Test cancelled. Let me know when you want to run it.'); sendState(ws, STATE.IDLE); return; }
      browserInstance = await chromium.launch({ headless: false });
      const { result, healCount } = await executePlan(ws, plan, s, userInput, baseUrl, browserInstance);
      send(ws, 'report', { status: result.status, healCount, scenarios: [{ scenario: s, result, healCount }], summary: { total: 1, passed: result.status === 'success' ? 1 : 0, failed: result.status === 'failed' ? 1 : 0, skipped: 0, healed: healCount } });
      sendState(ws, STATE.IDLE);
      return;
    }

    // ── Route C: Module ───────────────────────────────────────────────────────
    if (route === 'MODULE') {
      phase(ws, '── Checking memory ──');
      const memoryCheck = docScenarios.map(s => ({ scenario: s, cached: findSimilarPlan(module, s.id, userInput) }));
      const cachedCount = memoryCheck.filter(r => r.cached).length;
      log(ws, `${cachedCount} of ${docScenarios.length} scenarios cached`, cachedCount === docScenarios.length ? 'success' : 'info');
      const uncached = memoryCheck.filter(r => !r.cached).map(r => r.scenario);
      if (uncached.length > 0) {
        phase(ws, '── Capturing browser state ──');
        const browserCtx = await captureBrowserContext(baseUrl);
        log(ws, `DOM captured at ${baseUrl}`, 'info');
        phase(ws, '── Generating missing plans ──');
        log(ws, `Generating: ${uncached.map(s => s.name).join(', ')}`, 'info');
        const batch = await generateAllScenarioSteps(uncached, docContext, browserCtx);
        batch.forEach(p => { validatePlan(p); saveToMemory(p); log(ws, `Saved: "${p.module}__${p.scenario}"`, 'success'); const m = memoryCheck.find(r => r.scenario.id === p.id); if (m) m.cached = p; });
      }
      sendState(ws, STATE.PLANNING);
      send(ws, 'scenarios', { scenarios: docScenarios, module: userInput });
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
      send(ws, 'report', { status: failed === 0 ? 'success' : 'failed', healCount: totalHealed, scenarios: scenarioResults, summary: { total: toRun.length, passed, failed, skipped, healed: totalHealed } });
      sendState(ws, STATE.IDLE);
      return;
    }

    // ── Route D: LLM analysis ─────────────────────────────────────────────────
    phase(ws, '── Analyzing request ──');
    const browserCtx = await captureBrowserContext(baseUrl);
    const { enrichedInput } = await gatherContext(userInput, null, (q) => askUser(ws, q), (t, l) => log(ws, t, l));
    log(ws, 'Sending to Gemini...', 'info');
    const analysis = await analyzeRequest(enrichedInput, docContext, browserCtx);
    send(ws, 'intent', { intent: analysis.intent, confidence: 'high' });
    log(ws, `Intent: ${analysis.intent}`, 'info');
    if (analysis.intent === 'OUT_OF_SCOPE') { send(ws, 'agent_message', outOfScopeResponse(userInput)); return; }
    if (analysis.intent === 'EXPLORE' || analysis.intent === 'UNDERSTAND') { send(ws, 'agent_message', buildExploreResponse(docScenarios, allDocs, userInput)); return; }
    const scenarios = docScenarios.length > 0 ? docScenarios : (analysis.scenarios || []);
    if (!scenarios.length) { send(ws, 'agent_message', 'Could not identify scenarios. Try being more specific.'); return; }
    sendState(ws, STATE.PLANNING);
    const planMap = {};
    const stillUncached = scenarios.filter(s => { const p = findSimilarPlan(module, s.id); if (p) { planMap[s.id] = p; return false; } return true; });
    if (stillUncached.length > 0) {
      const batch = await generateAllScenarioSteps(stillUncached, docContext, browserCtx);
      batch.forEach(p => { validatePlan(p); saveToMemory(p); planMap[p.id] = p; log(ws, `Saved: "${p.module}__${p.scenario}"`, 'success'); });
    }
    send(ws, 'scenarios', { scenarios, module: userInput });
    const choice2 = await waitForAnswer(ws);
    send(ws, 'answer_received', choice2);
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
    send(ws, 'report', { status: rf === 0 ? 'success' : 'failed', healCount: rh, scenarios: rr, summary: { total: finalToRun.length, passed: rp, failed: rf, skipped: rs, healed: rh } });
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