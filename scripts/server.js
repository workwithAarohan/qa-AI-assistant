/**
 * QA Sentinel v2 — server-v2.js
 * Three-panel architecture: Chat | Dashboard | Execution+Report
 */
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import dotenv from 'dotenv';
import fs from 'fs';
dotenv.config();

import { think, planFeature, generateAllScenarioSteps, fixSteps, recordOutcome, recordHeal, recordFailure } from './agent.js';
import { runSteps } from './executor.js';
import { validatePlan } from './validator.js';
import { saveToMemory, findSimilarPlan, listMemory, repairMemory } from './memory.js';
import { loadAllDocs } from './context.js';
import { captureBrowserContext } from './browser-context.js';
import { classifyFailure, DECISION_META } from './failure-classifier.js';
import { guardCheck, IDENTITY_ANCHOR } from './guard.js';
import { generate as llm } from './llm.js';
import { runScenario as runWithRunner, getRunners } from './runners/runner-orchestrator.js';
import mockApiRouter from './mock-api.js';
import { decideConversation } from './conversation-decision.js';
import {
  speakClarification,
  speakPlanReady,
  speakExecutionProposal,
  speakExploreFallback,
  speakDesignPrompt,
  speakResultQuestion,
} from './conversation-speaker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ── App Registry ──────────────────────────────────────────────────────────────
function loadApps() {
  try {
    const p = path.join(process.cwd(), 'apps.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  return [{ id: 'testapp', name: process.env.APP_NAME || 'TestApp', description: 'Primary application', baseUrl: process.env.BASE_URL || 'http://localhost:4000/testapp', docsDir: process.env.DOCS_DIR || './docs', color: '4F46E5', icon: 'T' }];
}
function getApp(id) { return loadApps().find(a => a.id === id) || loadApps()[0]; }

// ── Module loading ────────────────────────────────────────────────────────────
function loadModulesForApp(app) {
  try {
    const docs = loadAllDocs(app.docsDir);
    return docs.map(doc => {
      const urlM  = doc.content.match(/##\s*URL\s*\n(https?:\/\/[^\s]+)/i);
      const descM = doc.content.match(/##\s*Description\s*\n([\s\S]*?)(?=\n##|$)/i);
      const secM  = doc.content.match(/##\s*Test Scenarios\s*\n([\s\S]*?)(?=\n##|$)/i);
      const scenarios = secM
        ? secM[1].trim().split('\n').map(l => { const m = l.match(/[-*]\s*([a-z_]+):\s*(.+)/i); return m ? { id: m[1].trim().toLowerCase(), name: m[1].trim().replace(/_/g,' '), description: m[2].trim(), module: doc.name } : null; }).filter(Boolean)
        : [];
      const cachedCount = scenarios.filter(s => !!findSimilarPlan(doc.name, s.id)).length;
      return { id: doc.name, name: doc.name.charAt(0).toUpperCase() + doc.name.slice(1), description: descM?.[1]?.trim()?.split('\n')[0] || '', url: urlM?.[1] || '', scenarios, cachedCount };
    });
  } catch { return []; }
}

// ── Per-connection state ──────────────────────────────────────────────────────
const connState = new WeakMap();
const sessionState = new Map();
function getState(ws) {
  if (!connState.has(ws)) connState.set(ws, { currentApp: loadApps()[0], lastRun: null, history: [] });
  return connState.get(ws);
}

// Add a turn to conversation history — keep last 5 only
function pushHistory(st, role, text) {
  st.history.push({ role, text: text.slice(0, 300) });
  if (st.history.length > 10) st.history = st.history.slice(-10);
}

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
app.use(express.json());
app.use((_, res, next) => { res.setHeader('Content-Security-Policy', ["default-src 'self'","connect-src 'self' ws:","script-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com","style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com","font-src https://fonts.gstatic.com data:","img-src 'self' data:"].join('; ')); next(); });
app.use(express.static(ROOT));
app.get('/testapp',   (_, r) => r.sendFile(path.join(ROOT, 'public', 'testapp.html')));
app.get('/dashboard', (_, r) => r.sendFile(path.join(ROOT, 'public', 'dashboard.html')));
app.get('/projects',  (_, r) => r.sendFile(path.join(ROOT, 'public', 'projects.html')));
app.get('/profile',   (_, r) => r.sendFile(path.join(ROOT, 'public', 'profile.html')));

// REST API
app.get('/api/apps',           (_, res) => res.json(loadApps()));
app.get('/api/modules/:appId', (req, res) => { try { res.json(loadModulesForApp(getApp(req.params.appId))); } catch(e) { res.status(500).json({error:e.message}); }});
app.get('/api/memory',         (_, res) => { try { res.json({plans:listMemory()}); } catch(e) { res.status(500).json({error:e.message}); }});
app.delete('/api/memory/:mod/:scen', (req, res) => {
  try {
    const mp = path.join(process.cwd(), 'memory.json');
    const mem = fs.existsSync(mp) ? JSON.parse(fs.readFileSync(mp,'utf8')) : {};
    const key = `${req.params.mod}__${req.params.scen}`;
    const deleted = !!mem[key]; delete mem[key];
    fs.writeFileSync(mp, JSON.stringify(mem,null,2));
    res.json({deleted,key});
  } catch(e) { res.status(500).json({error:e.message}); }
});
app.post('/api/memory/repair', (_, res) => { try { res.json(repairMemory()); } catch(e) { res.status(500).json({error:e.message}); }});

// ── DataApp mock API ──────────────────────────────────────────────────────────
app.use('/api/dataapp', mockApiRouter);

// ── DataApp HTML pages ────────────────────────────────────────────────────────
app.get('/dataapp/tables',     (_, r) => r.sendFile(path.join(ROOT, 'public', 'dataapp-tables.html')));
app.get('/dataapp/validation', (_, r) => r.sendFile(path.join(ROOT, 'public', 'dataapp-validation.html')));

// ── Runner metadata REST ──────────────────────────────────────────────────────
app.get('/api/runners', (_, res) => res.json(getRunners()));

// ── Helpers ───────────────────────────────────────────────────────────────────
const send  = (ws, type, data) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type, data })); };
const log   = (ws, text, level = 'info') => { console.log(`[${level}] ${text}`); send(ws, 'log', { text, level }); };
const phase = (ws, text) => send(ws, 'log', { text, level: 'phase' });
const planProgress = (ws, data) => send(ws, 'plan_progress', data);

function layerLabel(type) {
  return ({
    API: 'API checks',
    DATA_VALIDATION: 'data validation',
    UI: 'UI testing',
    PERFORMANCE: 'performance testing',
  })[type] || String(type || 'testing').replace(/_/g, ' ').toLowerCase();
}

function summarizePlanForChat(plan) {
  return speakPlanReady(plan);
}

function buildPlanInput(text, decision) {
  const moduleName = decision.intent?.scope?.module?.name || decision.intent?.scope?.module?.id;
  if (moduleName && /^(yes|yeah|yep|sure|ok|okay|please do|do it|go ahead|sounds good|proceed)\b/i.test(text)) {
    return `Create a comprehensive layered test plan ONLY for the ${moduleName} module. Do not include related modules or post-login destination modules.`;
  }
  if (moduleName) {
    return `${text}. Scope this plan ONLY to the ${moduleName} module. Do not include related modules or post-login destination modules.`;
  }
  return text;
}

function speakExploreDecision(decision, appName = 'this app') {
  const module = decision.intent?.scope?.module;
  const testType = decision.intent?.scope?.testType;
  if (module) {
    const scenarios = module.scenarios || [];
    const scenarioText = scenarios.length
      ? scenarios.slice(0, 6).map(s => `- **${s.name}**: ${s.description}`).join('\n')
      : '- No documented scenarios yet.';
    return `The **${module.name}** module has ${scenarios.length} documented scenario${scenarios.length === 1 ? '' : 's'}.\n${scenarioText}`;
  }
  if (testType === 'api') {
    return `API testing checks HTTP contracts, schemas, status codes, validation errors, and cross-endpoint consistency. Switch to the API Tests runner, then use a scenario Run button, module Run all, or Run All (API).`;
  }
  return speakExploreFallback(null, appName);
}

function enforcePlanScope(plan, moduleId, docs = []) {
  if (!moduleId || !plan?.layers) return plan;
  const doc = docs.find(d => d.name === moduleId);
  const sec = doc?.content.match(/##\s*Test Scenarios\s*\n([\s\S]*?)(?=\n##|$)/i);
  const docScenarios = sec ? sec[1].trim().split('\n').map(line => {
    const m = line.match(/[-*]\s*([a-z_]+):\s*(.+)/i);
    return m ? { id: m[1].toLowerCase(), name: titleCase(m[1].replace(/_/g, ' ')), module: moduleId, description: m[2].trim() } : null;
  }).filter(Boolean) : [];
  const docIds = new Set(docScenarios.map(s => s.id));

  const scopedLayers = plan.layers
    .map(layer => ({
      ...layer,
      scenarios: (layer.scenarios || []).filter(s =>
        String(s.module || '').toLowerCase() === moduleId.toLowerCase() &&
        (!docIds.size || docIds.has(String(s.id || '').toLowerCase()))
      ),
    }))
    .filter(layer => layer.scenarios.length > 0);

  if (scopedLayers.length) {
    const hasUiLayer = scopedLayers.some(l => l.runner === 'ui' || l.type === 'UI');
    const normalizedLayers = scopedLayers.map(layer =>
      (docScenarios.length && (layer.runner === 'ui' || layer.type === 'UI'))
        ? { ...layer, scenarios: docScenarios }
        : layer
    );
    if (docScenarios.length && !hasUiLayer) {
      normalizedLayers.push({
        type: 'UI',
        reason: `Verify the documented ${moduleId} user flows.`,
        runner: 'ui',
        scenarios: docScenarios,
        depends_on: scopedLayers.at(-1)?.type || null,
      });
    }
    const recommended_order = (plan.recommended_order || []).filter(t => normalizedLayers.some(l => l.type === t));
    return {
      ...plan,
      feature: `${titleCase(moduleId)} Module`,
      layers: normalizedLayers,
      recommended_order: recommended_order.length ? recommended_order : normalizedLayers.map(l => l.type),
      ui_only: normalizedLayers.every(l => l.runner === 'ui'),
    };
  }

  return {
    feature: `${titleCase(moduleId)} Module`,
    risk: plan.risk || 'medium',
    risk_reason: doc ? `Focused coverage for the ${moduleId} module only.` : plan.risk_reason || '',
    ui_only: true,
    layers: [{
      type: 'UI',
      reason: `Verify the documented ${moduleId} user flows.`,
      runner: 'ui',
      scenarios: docScenarios,
      depends_on: null,
    }],
    recommended_order: ['UI'],
  };
}

function titleCase(text) {
  return String(text || '').replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function parseScenariosFromDoc(doc) {
  const sec = doc?.content.match(/##\s*Test Scenarios\s*\n([\s\S]*?)(?=\n##|$)/i);
  return sec ? sec[1].trim().split('\n').map(line => {
    const m = line.match(/[-*]\s*([a-z_]+):\s*(.+)/i);
    return m ? {
      id: m[1].trim().toLowerCase(),
      name: m[1].trim().replace(/_/g, ' '),
      description: m[2].trim(),
      module: doc.name,
    } : null;
  }).filter(Boolean) : [];
}

function runnerAppliesToScenario(runnerId, scenario = {}) {
  if (!runnerId || runnerId === 'ui') return true;
  const id = String(scenario.id || scenario.name || '').toLowerCase();
  const mod = String(scenario.module || '').toLowerCase();
  if (runnerId === 'data') {
    return mod.includes('table') || id.includes('table') || id.includes('filter') ||
      id.includes('sort') || id.includes('paginat') || id.includes('export');
  }
  if (runnerId === 'api') {
    return mod.includes('table') || mod.includes('validation') || mod.includes('dataapp') ||
      id.includes('api') || id.includes('validate');
  }
  if (runnerId === 'perf') {
    return id.includes('filter') || id.includes('search') || id.includes('load') ||
      mod.includes('table') || id.includes('paginat');
  }
  return true;
}

function reportFromRunnerResults(results, runnerId, type = 'runner') {
  const passed = results.filter(r => r.result?.status === 'success' || r.result?.status === 'pass').length;
  const failed = results.filter(r => r.result?.status === 'failed' || r.result?.status === 'fail').length;
  const skipped = results.filter(r => r.result?.status === 'skipped' || r.result?.status === 'skip').length;
  return {
    type,
    runnerId,
    status: failed === 0 ? 'success' : 'failed',
    healCount: 0,
    scenarios: results,
    summary: { total: results.length, passed, failed, skipped, healed: 0 },
  };
}

async function runSpecialistSuite(ws, runnerId, scenarios, runApp, type = 'runner') {
  const filtered = scenarios.filter(s => runnerAppliesToScenario(runnerId, s));
  if (!filtered.length) {
    send(ws, 'chat_reply', { text: `No ${runnerId.toUpperCase()} scenarios are available for this scope.`, intent: 'warn' });
    send(ws, 'agent_state', 'idle');
    return null;
  }

  const results = [];
  let stepOffset = 0;
  for (const scenario of filtered) {
    phase(ws, `── [${runnerId.toUpperCase()}] ${scenario.module}/${scenario.name} ──`);
    send(ws, 'scenario_start', scenario);
    try {
      const result = await runWithRunner(runnerId, scenario, {
        baseUrl: runApp.baseUrl,
        headless: false,
        onStep: (i, step, status) => send(ws, 'step', { index: stepOffset + i, step, status }),
        onLog: (text, level) => log(ws, text, level),
      });
      results.push({ scenario, result, healCount: 0, healMeta: null });
      stepOffset += result.steps?.length || 0;
    } catch (e) {
      log(ws, `${scenario.name}: ${e.message}`, 'error');
      results.push({ scenario, result: { status: 'fail', steps: [], error: e.message }, healCount: 0, healMeta: null });
    }
    await new Promise(r => setTimeout(r, 300));
  }

  const rpt = reportFromRunnerResults(results, runnerId, type);
  send(ws, 'report', rpt);
  return rpt;
}

function waitForHealAnswer(ws, ms = 1_800_000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.off('message', h); reject(new Error('Timeout')); }, ms);
    function h(raw) { try { const m = JSON.parse(raw); if (m.type === 'heal_answer') { clearTimeout(t); ws.off('message', h); resolve(m.data); } } catch {} }
    ws.on('message', h);
  });
}

function injectUrl(plan, baseUrl) {
  if (!baseUrl || !plan?.steps) return plan;
  let origin = baseUrl;
  try { origin = new URL(baseUrl).origin; } catch {}
  return {
    ...plan,
    steps: plan.steps.map(s => {
      if (s.action !== 'navigate' || !s.value || s.value.startsWith('http')) return s;
      const path = s.value.startsWith('/') ? s.value : '/' + s.value;
      return { ...s, value: origin + path };
    }),
  };
}

// ── Live DOM ──────────────────────────────────────────────────────────────────
async function captureLiveDom(page) {
  try {
    const snap = await page.evaluate(() => {
      const SELECTORS = 'button,input,select,textarea,[type="submit"],[role="button"],[id],[data-testid],[aria-label],h1,h2,h3,a[href]:not([href^="#"])';
      const seen = new Set(), els = [];
      document.querySelectorAll(SELECTORS).forEach(el => {
        const r = el.getBoundingClientRect();
        if (!r.width && !r.height) return;
        const key = (el.id ? `#${el.id}` : '') + el.tagName;
        if (seen.has(key)) return; seen.add(key);
        const e = { tag: el.tagName.toLowerCase(), id: el.id||null, type: el.getAttribute('type')||null, ariaLabel: el.getAttribute('aria-label')||null, dataTestid: el.getAttribute('data-testid')||null, text: el.innerText?.trim().slice(0,60)||null };
        Object.keys(e).forEach(k => e[k]===null&&delete e[k]); els.push(e);
      });
      return { url: location.href, title: document.title, elements: els.slice(0,80) };
    });
    const lines = [`URL: ${snap.url}`, `Title: ${snap.title}`, 'Elements:'];
    snap.elements.forEach(el => { const p=[el.tag]; if(el.id) p.push(`#${el.id}`); if(el.type) p.push(`[type=${el.type}]`); if(el.dataTestid) p.push(`[data-testid="${el.dataTestid}"]`); if(el.ariaLabel) p.push(`[aria-label="${el.ariaLabel}"]`); if(el.text) p.push(`"${el.text}"`); lines.push('  '+p.join(' ')); });
    return lines.join('\n');
  } catch (e) { return `Capture failed: ${e.message}`; }
}

function buildHealCtx(plan, result, failedSR, liveDom) {
  const fi = failedSR ? (result.results||[]).indexOf(failedSR) : -1;
  const passed = (result.results||[]).filter(r=>r.status==='success').map((r,_,a)=>`  ✓ ${a.indexOf(r)+1}. ${r.step?.action} ${r.step?.selector||r.step?.value||''}`);
  return [
    '## Live DOM at failure — use to find correct selectors', liveDom||'(none)', '',
    `## ONLY step ${fi+1} failed — fix it surgically`,
    `Step ${fi+1}: ${failedSR?.step?.action} ${failedSR?.step?.selector||failedSR?.step?.value||''}`,
    `Error: ${failedSR?.error||result.error}`, '',
    '## Steps that PASSED — do NOT touch', ...passed, '',
    '## Full original plan (reference only)', (plan.steps||[]).map((s,i)=>`  ${i+1}. ${s.action} ${s.selector||s.value||''}`).join('\n'), '',
    `## RULE: Return the complete plan JSON. Fix ONLY step ${fi+1}. All other steps must be character-for-character identical.`,
  ].join('\n');
}

function splicePlan(origPlan, healedPlan, fi) {
  const orig = origPlan.steps || [], healed = healedPlan.steps || [];
  return { ...origPlan, steps: orig.map((s, i) => (i === fi && healed[i]) ? healed[i] : s) };
}

function computeDiff(orig, healed) {
  const changes = [], max = Math.max(orig.length, healed.length);
  for (let i = 0; i < max; i++) {
    const o = orig[i], h = healed[i];
    if (!o && h) { changes.push({type:'added',index:i,step:h}); continue; }
    if (o && !h) { changes.push({type:'removed',index:i,step:o}); continue; }
    const ok = `${o.action}:${o.selector||''}:${o.value||''}`, hk = `${h.action}:${h.selector||''}:${h.value||''}`;
    if (ok !== hk) changes.push({type:'changed',index:i,original:o,healed:h});
  }
  return { changes, originalLength: orig.length, healedLength: healed.length };
}

// ── Get or generate plan ──────────────────────────────────────────────────────
// ws is optional — when provided, logs generation progress to the execution panel
async function getPlan(scenario, app, ws = null) {
  const logGen = (text, level = 'info') => {
    console.log(`[getPlan] ${text}`);
    if (ws) send(ws, 'log', { text, level });
  };

  // 1. Memory cache — fast path
  const cached = findSimilarPlan(scenario.module, scenario.id);
  if (cached) {
    logGen(`Cache hit: ${scenario.module}/${scenario.id} (${cached.steps?.length} steps)`, 'success');
    return cached;
  }

  // 2. Not cached — generate via LLM
  logGen(`No cached plan for "${scenario.name}" — generating via LLM...`, 'warn');
  if (ws) send(ws, 'log', { text: 'Loading documentation context...', level: 'info' });

  const docs    = loadAllDocs(app.docsDir);
  const docCtx  = docs.find(d => d.name === scenario.module)?.content || '';

  if (ws) send(ws, 'log', { text: 'Capturing live browser DOM...', level: 'info' });
  const browserCtx = await captureBrowserContext(app.baseUrl).catch(() => '');

  if (ws) send(ws, 'log', { text: 'Asking LLM to generate test steps...', level: 'info' });

  const batch = await generateAllScenarioSteps([scenario], docCtx, browserCtx);
  const plan  = batch[0];

  if (!plan || !plan.steps?.length) {
    throw new Error(`LLM returned empty plan for "${scenario.name}". Check your docs or try again.`);
  }

  validatePlan(plan);
  saveToMemory(plan);
  logGen(`Generated & cached: ${plan.module}/${plan.scenario} (${plan.steps.length} steps)`, 'success');
  return plan;
}

// ── Execute one scenario ──────────────────────────────────────────────────────
async function executeScenario(ws, plan, scenario, baseUrl, browser, appId = 'default') {
  const finalPlan = injectUrl(plan, baseUrl);
  send(ws, 'execution_plan', { ...finalPlan, scenarioId: scenario.id });
  let liveDom = null, liveUrl = null;

  let result = await runSteps(finalPlan.steps, {
    browser, baseUrl,
    onStep:  (i, s, st) => send(ws, 'step', { index: i, step: s, status: st }),
    onLog:   (t, l) => log(ws, t, l),
    onFail:  async (page) => { try { liveUrl = page.url(); liveDom = await captureLiveDom(page); log(ws, `DOM captured: ${liveUrl}`, 'info'); } catch {} },
  });

  let healCount = 0, healMeta = null;

  if (result.status === 'failed') {
    phase(ws, '── Analysing failure ──');
    const failedSR = (result.results||[]).find(r => r.status === 'failed') || null;
    const fi = failedSR ? result.results.indexOf(failedSR) : -1;
    const clf = classifyFailure(failedSR?.step, result.error, result.results);
    log(ws, `Failure: ${clf.type} — ${clf.reason}`, 'warn');

    if (!liveDom && DECISION_META[clf.decision].canHeal) {
      try { liveDom = await captureBrowserContext(liveUrl || baseUrl); } catch {}
    }
    const candidates = (liveDom || '').split('\n')
      .filter(l => /^\s+(button|input|\[type=submit\]|\[role=button\])/.test(l))
      .map(l => l.trim()).slice(0, 6);

    send(ws, 'heal_prompt', {
      error: result.error, classification: clf,
      canHeal: DECISION_META[clf.decision].canHeal,
      failedStep: failedSR?.step ?? null, failedIndex: fi,
      passedCount: (result.results||[]).filter(r=>r.status==='success').length,
      totalSteps: finalPlan.steps.length,
      healPreview: { failedSelector: failedSR?.step?.selector||'', liveUrl: liveUrl||baseUrl, candidates, domElementCount: (liveDom||'').split('\n').filter(l=>l.startsWith('  ')).length },
    });

    const choice = await waitForHealAnswer(ws);

    if (/yes|heal|fix/i.test(choice) && DECISION_META[clf.decision].canHeal) {
      phase(ws, '── Auto-healing ──');
      log(ws, 'Sending live DOM to LLM...', 'info');
      const healCtx  = buildHealCtx(finalPlan, result, failedSR, liveDom);
      const fixedRaw = await fixSteps(finalPlan, result.error, '', healCtx);
      const fixedPlan = splicePlan(finalPlan, fixedRaw, fi);
      validatePlan(fixedPlan);
      const fixedU = injectUrl(fixedPlan, baseUrl);
      const diff = computeDiff(finalPlan.steps, fixedU.steps);
      send(ws, 'heal_diff', diff);
      send(ws, 'execution_plan', { ...fixedU, scenarioId: scenario.id });
      phase(ws, '── Retrying healed plan ──');
      liveDom = null; liveUrl = null;
      result = await runSteps(fixedU.steps, {
        browser, baseUrl,
        onStep: (i,s,st) => send(ws,'step',{index:i,step:s,status:st}),
        onLog:  (t,l) => log(ws,t,l),
        onFail: async (page) => { try { liveUrl=page.url(); liveDom=await captureLiveDom(page); } catch {} },
      });
      healCount++;
      if (result.status === 'success') {
        log(ws, 'Heal succeeded ✓', 'success');
        saveToMemory(fixedPlan);
        healMeta = { failedStep: failedSR?.step??null, failedIndex: fi, fixedStep: fixedPlan.steps[fi]??null, diff, classification: clf };
        // Record heal outcome in learning memory
        if (failedSR?.step?.selector && fixedPlan.steps[fi]?.selector) {
          recordHeal(appId, failedSR.step.selector, fixedPlan.steps[fi].selector, scenario.module);
        }
      } else {
        log(ws, 'Heal also failed.', 'error');
        send(ws, 'heal_failed', { error: result.error, classification: clf });
      }
    } else {
      log(ws, 'Stopped by user.', 'warn');
    }
    result._classification = clf;
  } else {
    saveToMemory(finalPlan);
    log(ws, `Cached: "${finalPlan.module}__${finalPlan.scenario}"`, 'success');
  }

  return { result, healCount, healMeta };
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
wss.on('connection', ws => {
  const st = getState(ws);
  console.log('Client connected');
  try {
    send(ws, 'apps', loadApps());
    send(ws, 'modules', loadModulesForApp(st.currentApp));
    send(ws, 'agent_state', 'idle');
  } catch {}

  ws.on('message', async raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const { type, data } = msg;
    const st = getState(ws);

    if (type === 'session_init') {
      const sessionId = String(data?.sessionId || '').slice(0, 80);
      if (sessionId) {
        const existing = sessionState.get(sessionId) || st;
        existing.sessionId = sessionId;
        connState.set(ws, existing);
        sessionState.set(sessionId, existing);
        send(ws, 'apps', loadApps());
        send(ws, 'modules', loadModulesForApp(existing.currentApp || loadApps()[0]));
        send(ws, 'conversation_history', existing.history || []);
        log(ws, `Session restored with ${(existing.history || []).length} remembered turns.`, 'info');
      }
      return;
    }

    // Switch app
    if (type === 'set_app') {
      const newApp = getApp(data);
      if (newApp) { st.currentApp = newApp; st.lastRun = null; st.history = []; send(ws,'modules',loadModulesForApp(newApp)); send(ws,'chat_reply',{text:`Switched to **${newApp.name}**. Session reset — ready to test.`,intent:'system'}); }
      return;
    }

    // ── Chat — powered by think() ─────────────────────────────────────────────
    if (type === 'chat') {
      const text = (data||'').trim(); if (!text) return;
      const g = guardCheck(text);
      if (!g.safe) { send(ws, 'chat_reply', { text: g.reason, intent: 'error' }); return; }

      send(ws, 'agent_state', 'thinking');
      pushHistory(st, 'user', text);
      log(ws, `Understanding request: "${text}"`, 'info');

      const docs       = loadAllDocs(st.currentApp.docsDir);
      const appContext = { ...st.currentApp, docs };
      const sessionCtx = { lastRun: st.lastRun, history: st.history.slice(-10), appId: st.currentApp.id };
      log(ws, 'Checking conversation mode and readiness.', 'info');
      const conversationDecision = decideConversation(text, appContext, sessionCtx);
      log(ws, `Decision: ${conversationDecision.mode} -> ${conversationDecision.nextAction.type}`, 'info');

      if (conversationDecision.mode === 'RESULT') {
        const reply = speakResultQuestion(text, st.lastRun);
        pushHistory(st, 'agent', reply);
        send(ws, 'chat_reply', { text: reply, intent: 'RESULT' });
        send(ws, 'agent_state', 'idle');
        return;
      }

      if (conversationDecision.nextAction.type === 'ask_question') {
        const reply = speakClarification(conversationDecision, st.currentApp.name);
        pushHistory(st, 'agent', reply);
        send(ws, 'chat_reply', { text: reply, intent: 'CLARIFY' });
        send(ws, 'agent_state', 'idle');
        return;
      }

      if (conversationDecision.mode === 'PLAN') {
        const planInput = buildPlanInput(text, conversationDecision);
        log(ws, `Generating visual plan from: "${planInput}"`, 'info');
        let planResult = await planFeature(planInput, { ...st.currentApp, docs }, { lastRun: st.lastRun, appId: st.currentApp.id });
        planResult = enforcePlanScope(planResult, conversationDecision.intent?.scope?.module?.id, docs);
        const reply = speakPlanReady(planResult);
        pushHistory(st, 'agent', reply);
        send(ws, 'test_plan_proposal', planResult);
        send(ws, 'chat_reply', { text: reply, intent: 'PLAN' });
        send(ws, 'agent_state', 'idle');
        return;
      }

      if (conversationDecision.mode === 'EXECUTE') {
        const scenarios = conversationDecision.scenarios || [];
        log(ws, `Resolved ${scenarios.length} runnable scenario${scenarios.length === 1 ? '' : 's'} for dashboard selection.`, 'success');
        const reply = speakExecutionProposal(scenarios);
        pushHistory(st, 'agent', reply);
        send(ws, 'chat_reply', { text: reply, intent: 'EXECUTE', scenarios });
        send(ws, 'agent_state', 'idle');
        return;
      }

      if (conversationDecision.mode === 'EXPLORE') {
        const reply = speakExploreDecision(conversationDecision, st.currentApp.name);
        pushHistory(st, 'agent', reply);
        send(ws, 'chat_reply', { text: reply, intent: 'EXPLORE' });
        send(ws, 'agent_state', 'idle');
        return;
      }

      if (conversationDecision.mode === 'DESIGN' && !/create|build|generate|make|add|custom/i.test(text)) {
        const reply = speakDesignPrompt(conversationDecision);
        pushHistory(st, 'agent', reply);
        send(ws, 'chat_reply', { text: reply, intent: 'DESIGN' });
        send(ws, 'agent_state', 'idle');
        return;
      }

      let decision;
      try {
        decision = await think(text, appContext, sessionCtx);
      } catch (err) {
        log(ws, `think() error: ${err.message}`, 'error');
        send(ws, 'chat_reply', { text: "Something went wrong reasoning about that. Try again or rephrase.", intent: 'error' });
        send(ws, 'agent_state', 'idle');
        return;
      }

      const { intent, confidence, response, scenarios, needs_clarification, clarifying_question } = decision;

      // ── Clarification needed ───────────────────────────────────────────────
      if (needs_clarification && clarifying_question) {
        pushHistory(st, 'agent', clarifying_question);
        send(ws, 'chat_reply', { text: clarifying_question, intent: 'CLARIFY' });
        send(ws, 'agent_state', 'idle');
        return;
      }

      // ── PLAN — QA analyst layer analysis before execution ────────────────────
      if (intent === 'PLAN') {
        send(ws, 'agent_state', 'thinking');
        const planResult = await planFeature(text, { ...st.currentApp, docs }, { lastRun: st.lastRun, appId: st.currentApp.id });
        pushHistory(st, 'agent', `Plan: ${planResult.feature}`);
        // Send structured plan to UI for confirmation
        send(ws, 'test_plan_proposal', planResult);
        // Also send a chat summary
        const reply = summarizePlanForChat(planResult);
        send(ws, 'chat_reply', { text: reply, intent: 'PLAN' });
        send(ws, 'agent_state', 'idle');
        return;
      }

      // ── EXECUTE — agent identified runnable scenarios ──────────────────────
      if (intent === 'EXECUTE' && scenarios?.length) {
        if (scenarios.length === 1) {
          const s = scenarios[0];
          const replyText = `I found **${s.name}** in the ${s.module} module. I won’t run it from chat automatically — use the visible Run button for that scenario when you’re ready.`;
          pushHistory(st, 'agent', replyText);
          send(ws, 'chat_reply', { text: replyText, intent: 'EXECUTE', scenarios });
          send(ws, 'agent_state', 'idle');
        } else {
          // Multiple scenarios — show them, let user pick or run all from dashboard
          const list = scenarios.map((s,i) => `${i+1}. **${s.name}** (${s.module}) — ${s.description||''}`).join('\n');
          const replyText = `I found ${scenarios.length} matching scenarios. I’ll keep chat light and let the dashboard handle execution:\n\n${list}\n\nUse a scenario Run button, module Run all, or the regression control when you’re ready.`;
          pushHistory(st, 'agent', replyText);
          send(ws, 'chat_reply', { text: replyText, intent: 'EXECUTE', scenarios });

          // Emit each scenario so the dashboard can highlight them
          scenarios.forEach(s => {
            if (s.module === 'custom') {
              send(ws, 'new_custom_scenario', { id: s.id, name: s.name, description: s.description||'', module: s.module });
            }
          });
          send(ws, 'agent_state', 'idle');
        }
        return;
      }

      // ── DISCUSS — build a custom scenario ─────────────────────────────────
      if (intent === 'DISCUSS' && /create|build|generate|make|add|custom/i.test(text)) {
        const docCtx = docs.map(d=>`### ${d.name}\n${d.content}`).join('\n\n').slice(0,3000);
        const buildPrompt = `${IDENTITY_ANCHOR}
User wants a custom test: "${text}"
App: ${appContext.name} (${appContext.baseUrl})
Docs:
${docCtx}
Return ONLY valid JSON:
{"name":"short name","description":"one sentence","module":"module_name","id":"snake_case_id","steps":[{"action":"navigate","value":"http://..."},{"action":"type","selector":"#id","value":"text"},{"action":"click","selector":"#id"},{"action":"expect","selector":"#id"}]}`;
        try {
          const r   = await llm(buildPrompt, { maxAttempts: 1 });
          const txt = r.response.text().replace(/\`\`\`json|\`\`\`/g,'').trim();
          const match = txt.match(/\{[\s\S]*\}/);
          if (match) {
            const plan = JSON.parse(match[0]);
            plan.module   = plan.module   || 'custom';
            plan.scenario = plan.id       || plan.name.toLowerCase().replace(/\s+/g,'_');
            validatePlan(plan); saveToMemory(plan);
            const msg = `Created **${plan.name}** — ${plan.steps.length} steps. Added to dashboard under "${plan.module}". Click Run to execute it.`;
            pushHistory(st, 'agent', msg);
            send(ws, 'chat_reply', { text: msg, intent: 'DISCUSS' });
            send(ws, 'new_custom_scenario', { id: plan.scenario||plan.id, name: plan.name, description: plan.description||'Custom test', module: plan.module });
            send(ws, 'agent_state', 'idle');
            return;
          }
        } catch (e) { console.error('Custom scenario build failed:', e.message); }
        const fallback = response || "Couldn't generate that scenario. Try: *'Create a test that logs in and checks the dashboard title'*";
        pushHistory(st, 'agent', fallback);
        send(ws, 'chat_reply', { text: fallback, intent: 'DISCUSS' });
        send(ws, 'agent_state', 'idle');
        return;
      }

      // ── EXPLORE / DISCUSS / POST_RUN_Q / OUT_OF_SCOPE — return response ───
      const reply = response || "I can help you explore modules, analyse test failures, or build custom scenarios.";
      pushHistory(st, 'agent', reply);
      send(ws, 'chat_reply', { text: reply, intent });
      send(ws, 'agent_state', 'idle');
      return;
    }

    // ── Run a full layer plan (from planFeature) ──────────────────────────────
    if (type === 'run_plan') {
      const { plan, layerIndex } = data; // layerIndex = null means run all layers
      const runApp = st.currentApp;
      const layers = layerIndex != null ? [plan.layers[layerIndex]] : plan.layers;

      send(ws, 'agent_state', 'running');
      send(ws, 'execution_start', { module: plan.feature, scenario: 'layer-plan', app: runApp.name });
      phase(ws, `── Plan: ${plan.feature} ──`);
      (plan.layers || []).forEach(l => planProgress(ws, { layer: l.type, status: 'pending' }));

      const allResults = [];
      let totalHealed = 0;

      for (const layer of layers) {
        planProgress(ws, { layer: layer.type, status: 'running' });
        phase(ws, `── Layer: ${layer.type} (${layer.runner}) ──`);
        log(ws, `${layer.reason}`, 'info');
        let layerFailed = false;
        let layerHealed = false;

        for (const scenario of layer.scenarios) {
          // Tag scenario with its runner
          const scenarioWithRunner = { ...scenario, runner: layer.runner };
          send(ws, 'scenario_start', scenarioWithRunner);
          planProgress(ws, { layer: layer.type, scenario: scenarioWithRunner, status: 'running' });

          if (layer.runner === 'ui') {
            // Standard Playwright execution
            let browser = null;
            try {
              const p = await getPlan(scenarioWithRunner, runApp, ws);
              browser = await chromium.launch({ headless: false });
              const { result, healCount, healMeta } = await executeScenario(ws, p, scenarioWithRunner, runApp.baseUrl, browser, runApp.id);
              allResults.push({ scenario: scenarioWithRunner, result, healCount, healMeta, layer: layer.type });
              totalHealed += healCount;
              if (result.status === 'failed') layerFailed = true;
              if (healCount > 0) layerHealed = true;
              planProgress(ws, { layer: layer.type, scenario: scenarioWithRunner, status: healCount > 0 ? 'healed' : (result.status === 'success' ? 'passed' : result.status) });
            } catch(e) {
              log(ws, `${scenario.name}: ${e.message}`, 'error');
              allResults.push({ scenario: scenarioWithRunner, result: { status:'failed', results:[], error: e.message }, healCount:0, healMeta:null, layer: layer.type });
              layerFailed = true;
              planProgress(ws, { layer: layer.type, scenario: scenarioWithRunner, status: 'failed' });
            } finally {
              if (browser) await browser.close();
            }
          } else {
            // Specialist runner (api / data / perf)
            try {
              const stepOffset = allResults.reduce((n, r) => n + (r.result?.steps?.length || 0), 0);
              const result = await runWithRunner(layer.runner, scenarioWithRunner, {
                baseUrl: runApp.baseUrl, headless: false,
                onStep: (i, s, st2) => send(ws, 'step', { index: stepOffset + i, step: s, status: st2 }),
                onLog:  (t, l) => log(ws, t, l),
              });
              allResults.push({ scenario: scenarioWithRunner, result, healCount: 0, healMeta: null, layer: layer.type });
              if (result.status === 'failed' || result.status === 'fail') layerFailed = true;
              planProgress(ws, { layer: layer.type, scenario: scenarioWithRunner, status: (result.status === 'success' || result.status === 'pass') ? 'passed' : result.status });
            } catch(e) {
              log(ws, `${scenario.name}: ${e.message}`, 'error');
              allResults.push({ scenario: scenarioWithRunner, result: { status:'failed', results:[], error: e.message }, healCount:0, healMeta:null, layer: layer.type });
              layerFailed = true;
              planProgress(ws, { layer: layer.type, scenario: scenarioWithRunner, status: 'failed' });
            }
          }
          await new Promise(r => setTimeout(r, 300));
        }
        planProgress(ws, { layer: layer.type, status: layerFailed ? 'failed' : layerHealed ? 'healed' : 'passed' });
      }

      const passed  = allResults.filter(r => r.result?.status === 'success' || r.result?.status === 'pass').length;
      const failed  = allResults.filter(r => r.result?.status === 'failed' || r.result?.status === 'fail').length;
      const skipped = allResults.filter(r => r.result?.status === 'skipped' || r.result?.status === 'skip').length;
      const rpt = {
        type: 'plan', status: failed === 0 ? 'success' : 'failed',
        healCount: totalHealed, scenarios: allResults,
        summary: { total: allResults.length, passed: passed - totalHealed, failed, skipped, healed: totalHealed },
      };
      send(ws, 'report', rpt);
      st.lastRun = rpt;
      send(ws, 'agent_state', 'idle');
      return;
    }

    // ── Run with specific runner (UI / data / API / perf) ───────────────────────
    if (type === 'run_with_runner') {
      const { runnerId, scenario, appId } = data;
      const runApp = appId ? getApp(appId) : st.currentApp;
      send(ws, 'agent_state', 'running');
      send(ws, 'execution_start', { module: scenario.module, scenario: scenario.id, app: runApp.name, runner: runnerId });
      phase(ws, `── [${runnerId.toUpperCase()}] ${scenario.module} / ${scenario.name} ──`);
      try {
        const result = await runWithRunner(runnerId, scenario, {
          baseUrl:  runApp.baseUrl,
          headless: false,
          onStep:   (i, s, st2) => send(ws, 'step', { index: i, step: s, status: st2 }),
          onLog:    (t, l) => log(ws, t, l),
        });
        const rpt = {
          runnerId,
          status:    result.status,
          healCount: 0,
          scenarios: [{ scenario, result, healCount: 0, healMeta: null }],
          summary:   { total: 1, passed: result.status === 'pass' ? 1 : 0, failed: result.status === 'fail' ? 1 : 0, skipped: 0, healed: 0 },
        };
        send(ws, 'report', rpt);
        st.lastRun = rpt;
      } catch (e) {
        log(ws, e.message, 'error');
        send(ws, 'execution_error', e.message);
      } finally {
        send(ws, 'agent_state', 'idle');
      }
      return;
    }

    // Run single scenario
    if (type === 'run_scenario') {
      const { module: modId, scenarioId, scenarioName, scenarioDesc } = data;
      const runApp = st.currentApp;
      send(ws,'agent_state','running'); send(ws,'execution_start',{module:modId,scenario:scenarioId,app:runApp.name});
      phase(ws,`── ${modId} / ${scenarioName||scenarioId} ──`);
      const scenario = { id:scenarioId, name:scenarioName||scenarioId.replace(/_/g,' '), description:scenarioDesc||'', module:modId };
      let browser = null;
      try {
        const plan = await getPlan(scenario, runApp, ws);
        browser = await chromium.launch({ headless: false });
        const { result, healCount, healMeta } = await executeScenario(ws, plan, scenario, runApp.baseUrl, browser, runApp.id);
        const rpt = { status:result.status, healCount, scenarios:[{scenario,result,healCount,healMeta}], summary:{total:1,passed:(result.status==='success'&&!healCount)?1:0,failed:result.status==='failed'?1:0,skipped:0,healed:healCount} };
        send(ws,'report',rpt); st.lastRun = rpt;
        recordOutcome(runApp.id, scenarioName||scenarioId, 'EXECUTE', [scenario]);
      } catch(e) { log(ws,e.message,'error'); send(ws,'execution_error',e.message); }
      finally { if(browser) await browser.close(); send(ws,'agent_state','idle'); }
      return;
    }

    // Run full module
    if (type === 'run_module') {
      const { module: modId, runnerId = 'ui', appId } = data;
      const runApp = appId ? getApp(appId) : st.currentApp;
      send(ws,'agent_state','running'); send(ws,'execution_start',{module:modId,scenario:'all',app:runApp.name,runner:runnerId});
      const docs = loadAllDocs(runApp.docsDir);
      const doc = docs.find(d=>d.name===modId);
      const scenarios = parseScenariosFromDoc(doc);
      if(!scenarios.length){send(ws,'chat_reply',{text:`No scenarios for "${modId}".`,intent:'warn'});send(ws,'agent_state','idle');return;}
      if (runnerId !== 'ui') {
        const rpt = await runSpecialistSuite(ws, runnerId, scenarios, runApp, 'module');
        if (rpt) st.lastRun = rpt;
        send(ws,'agent_state','idle');
        return;
      }
      const results=[]; let healed=0, browser=null;
      try {
        browser = await chromium.launch({headless:false});
        for(const s of scenarios){
          phase(ws,`── ${s.name} ──`); send(ws,'scenario_start',s);
          try { const plan=await getPlan(s,runApp,ws); const {result,healCount,healMeta}=await executeScenario(ws,plan,s,runApp.baseUrl,browser,runApp.id); results.push({scenario:s,result,healCount,healMeta}); healed+=healCount; }
          catch(e){ log(ws,`Failed to get plan for ${s.name}: ${e.message}`,'error'); results.push({scenario:s,result:{status:'failed',results:[],error:e.message},healCount:0,healMeta:null}); }
          await new Promise(r=>setTimeout(r,300));
        }
      } finally { if(browser) await browser.close(); }
      const passed=results.filter(r=>r.result.status==='success'&&!r.healCount).length, failed=results.filter(r=>r.result.status==='failed').length, skipped=results.filter(r=>r.result.status==='skipped').length;
      const rpt={status:failed===0?'success':'failed',healCount:healed,scenarios:results,summary:{total:results.length,passed,failed,skipped,healed}};
      send(ws,'report',rpt); st.lastRun=rpt; send(ws,'agent_state','idle'); return;
    }

    // Run regression
    if (type === 'run_regression') {
      const { runnerId = 'ui', appId } = data || {};
      const runApp = appId ? getApp(appId) : st.currentApp;
      send(ws,'agent_state','running'); send(ws,'execution_start',{module:'all',scenario:'regression',app:runApp.name,runner:runnerId});
      const docs = loadAllDocs(runApp.docsDir);
      const all = [];
      docs.forEach(d=>all.push(...parseScenariosFromDoc(d)));
      if (runnerId !== 'ui') {
        const rpt = await runSpecialistSuite(ws, runnerId, all, runApp, 'regression');
        if (rpt) st.lastRun = rpt;
        send(ws,'agent_state','idle');
        return;
      }
      const results=[]; let healed=0, browser=null;
      try {
        browser=await chromium.launch({headless:false});
        for(const s of all){
          phase(ws,`── ${s.module}/${s.name} ──`); send(ws,'scenario_start',s);
          try{const plan=await getPlan(s,runApp,ws);const {result,healCount,healMeta}=await executeScenario(ws,plan,s,runApp.baseUrl,browser,runApp.id);results.push({scenario:s,result,healCount,healMeta});healed+=healCount;}
          catch(e){log(ws,`Failed to get plan for ${s.name}: ${e.message}`,'error');results.push({scenario:s,result:{status:'failed',results:[],error:e.message},healCount:0,healMeta:null});}
          await new Promise(r=>setTimeout(r,300));
        }
      } finally{if(browser)await browser.close();}
      const passed=results.filter(r=>r.result.status==='success'&&!r.healCount).length,failed=results.filter(r=>r.result.status==='failed').length,skipped=results.filter(r=>r.result.status==='skipped').length;
      const rpt={type:'regression',status:failed===0?'success':'failed',healCount:healed,scenarios:results,summary:{total:results.length,passed,failed,skipped,healed}};
      send(ws,'report',rpt); st.lastRun=rpt; send(ws,'agent_state','idle'); return;
    }
  });

  ws.on('close', () => { connState.delete(ws); console.log('Client disconnected'); });
});

server.listen(4000, () => {
  console.log('QA Sentinel v2:  http://localhost:4000');
  console.log('TestApp:         http://localhost:4000/testapp');
  try { const r=repairMemory(); console.log(`[Memory] ${r.total} plans, ${r.changed} repaired.`); } catch {}
});

// ── DataApp standalone server on port 4001 ────────────────────────────────────
// Serves the DataApp HTML pages + proxies /api/dataapp/* to the same mock router.
// This way DataApp feels like a real separate application at localhost:4001.
const dataApp    = express();
const dataServer = createServer(dataApp);

dataApp.use(express.json());
dataApp.use((_, res, next) => {
  res.setHeader('Content-Security-Policy', ["default-src 'self'","connect-src 'self' ws:","script-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com","style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com","font-src https://fonts.gstatic.com data:","img-src 'self' data:"].join('; '));
  next();
});
dataApp.use('/api/dataapp', mockApiRouter);
dataApp.get('/',           (_, r) => r.sendFile(path.join(ROOT, 'public', 'dataapp-tables.html')));
dataApp.get('/tables',     (_, r) => r.sendFile(path.join(ROOT, 'public', 'dataapp-tables.html')));
dataApp.get('/validation', (_, r) => r.sendFile(path.join(ROOT, 'public', 'dataapp-validation.html')));
dataApp.use(express.static(path.join(ROOT, 'public')));
dataApp.use(express.static(path.join(ROOT, 'scripts')));

const DATAAPP_PORT = process.env.DATAAPP_PORT || 4001;
dataServer.listen(DATAAPP_PORT, () => {
  console.log(`DataApp:         http://localhost:${DATAAPP_PORT}`);
});
