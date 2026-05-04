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
  if (!connState.has(ws)) connState.set(ws, { currentApp: loadApps()[0], lastRun: null, currentPlan: null, history: [], temporaryScenarioPlans: {}, pendingScenarioSaves: [] });
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
    const normalizedLayers = scopedLayers;
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

function slugify(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'custom_scenario';
}

function scenarioKeyId(layerType, scenario = {}) {
  return `${layerType || 'UI'}:${scenario.module || 'general'}:${scenario.id || scenario.name || 'scenario'}`;
}

function isPlanRemoveRequest(text) {
  return /\b(remove|exclude|drop|skip|without|don'?t include|do not include)\b/i.test(text) &&
    /\b(scenario|case|check|layer|api|ui|performance|data|invalid|empty|valid|password|login)\b/i.test(text);
}

function isPlanOnlyRequest(text) {
  return /\b(only|just|keep only|only keep)\b/i.test(text) &&
    /\b(scenario|case|check|valid|invalid|empty|blank|login|password)\b/i.test(text);
}

function isPlanAddRequest(text) {
  return /\b(add|include|also|create|new)\b/i.test(text) &&
    /\b(scenario|case|check|valid|invalid|empty|blank|locked|login|user)\b/i.test(text);
}

function isPlanRefinementRequest(text) {
  return isPlanRemoveRequest(text) || isPlanOnlyRequest(text) || isPlanAddRequest(text);
}

function requestedScenarioDescriptors(text) {
  const lower = String(text || '').toLowerCase();
  const descriptors = [];
  const add = (d) => {
    if (!descriptors.some(x => x.id === d.id)) descriptors.push(d);
  };

  [...lower.matchAll(/\b([a-z]+(?:_[a-z0-9]+)+)\b/g)].forEach(m => {
    const id = m[1];
    add({ id, name: titleCase(id), aliases: [id, id.replace(/_/g, ' ')], description: titleCase(id) });
  });
  if (/\bempty\b|\bblank\b|\bempty fields\b/.test(lower)) {
    add({
      id: 'empty_fields',
      name: 'Empty Fields',
      aliases: ['empty_fields', 'empty fields', 'empty', 'blank'],
      description: 'Submit login form without filling any fields and verify the error message appears.',
      steps: [
        { action: 'navigate', value: '/testapp' },
        { action: 'click', selector: '#login-btn' },
        { action: 'expect', selector: '#error' },
      ],
    });
  }
  if (/\binvalid\b|\bwrong password\b|\binvalid password\b/.test(lower)) {
    add({
      id: 'invalid_password',
      name: 'Invalid Password',
      aliases: ['invalid_password', 'invalid password', 'wrong password', 'invalid'],
      description: 'Login with an invalid password and verify the error message appears.',
    });
  }
  if (/\bvalid\b/.test(lower) && !/\binvalid\b/.test(lower)) {
    add({
      id: 'valid_login',
      name: 'Valid Login',
      aliases: ['valid_login', 'valid login', 'valid'],
      description: 'Login with valid credentials and verify the dashboard opens.',
    });
  }
  if (/\blocked\b|\block(ed)? out\b/.test(lower)) {
    add({
      id: 'locked_out_user',
      name: 'Locked Out User',
      aliases: ['locked_out_user', 'locked out user', 'locked user', 'locked'],
      description: 'Try to sign in as a locked out user and verify access is blocked with a clear error.',
    });
  }
  return descriptors;
}

function scenarioMatchesDescriptor(scenario, descriptor) {
  const id = String(scenario?.id || '').toLowerCase();
  const name = String(scenario?.name || '').toLowerCase();
  const desc = String(scenario?.description || '').toLowerCase();
  const text = `${id} ${name} ${desc}`;
  if (!descriptor) return false;
  if (id === descriptor.id) return true;
  if (descriptor.id === 'valid_login') {
    return (/\bvalid\b/.test(text) || id === 'valid_login') && !/\binvalid\b/.test(text);
  }
  return (descriptor.aliases || []).some(alias => {
    const a = String(alias || '').toLowerCase();
    return a.includes('_') ? id === a : text.includes(a);
  });
}

function getPlanScenarios(plan) {
  return (plan?.layers || []).flatMap(layer => (layer.scenarios || []).map(s => ({ ...s, layerType: layer.type, runner: layer.runner })));
}

function findDocumentedScenario(docs, descriptor, preferredModule = null) {
  const candidates = [];
  for (const doc of docs) {
    for (const scenario of parseScenariosFromDoc(doc)) {
      if (preferredModule && scenario.module !== preferredModule) continue;
      if (scenarioMatchesDescriptor(scenario, descriptor)) candidates.push(scenario);
    }
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function inferPlanModule(plan, fallback = 'login') {
  const first = getPlanScenarios(plan)[0];
  return first?.module || fallback;
}

function createTemporaryScenario(descriptor, moduleId = 'login') {
  return {
    id: descriptor.id || slugify(descriptor.name),
    name: descriptor.name || titleCase(descriptor.id),
    module: moduleId,
    description: descriptor.description || `Temporary scenario for ${descriptor.name || descriptor.id}.`,
    temporary: true,
    source: 'temporary',
    steps: descriptor.steps || null,
  };
}

function normalizePlan(plan) {
  const layers = (plan.layers || []).filter(l => (l.scenarios || []).length);
  return {
    ...plan,
    layers,
    recommended_order: (plan.recommended_order || []).filter(t => layers.some(l => l.type === t)).length
      ? (plan.recommended_order || []).filter(t => layers.some(l => l.type === t))
      : layers.map(l => l.type),
    ui_only: layers.length ? layers.every(l => l.runner === 'ui') : !!plan.ui_only,
  };
}

function addScenarioToPlan(plan, scenario, layerType = 'UI', runner = 'ui') {
  const key = scenarioKeyId(layerType, scenario);
  const exists = getPlanScenarios(plan).some(s => scenarioKeyId(s.layerType, s) === key);
  if (exists) return { plan, changed: false };

  const layers = [...(plan.layers || [])];
  let index = layers.findIndex(l => l.type === layerType && (l.runner || runner) === runner);
  if (index === -1) {
    layers.push({ type: layerType, reason: 'User-added scenario.', runner, scenarios: [], depends_on: null });
    index = layers.length - 1;
  }
  layers[index] = { ...layers[index], scenarios: [...(layers[index].scenarios || []), scenario] };
  const recommended = plan.recommended_order?.includes(layerType) ? plan.recommended_order : [...(plan.recommended_order || []), layerType];
  return { plan: normalizePlan({ ...plan, layers, recommended_order: recommended }), changed: true };
}

function removeScenarioFromPlan(plan, matcher) {
  const removed = [];
  const layers = (plan.layers || []).map(layer => {
    const kept = [];
    for (const scenario of layer.scenarios || []) {
      if (matcher(scenario, layer)) removed.push({ ...scenario, layer: layer.type });
      else kept.push(scenario);
    }
    return { ...layer, scenarios: kept };
  });
  return { plan: normalizePlan({ ...plan, layers }), removed, changed: removed.length > 0 };
}

function applyOnlyScenarioScope(plan, text, docs = []) {
  const descriptors = requestedScenarioDescriptors(text);
  if (!descriptors.length || !plan?.layers?.length) return { plan, added: [], removed: [], changed: false };

  const moduleId = inferPlanModule(plan);
  const removed = [];
  const keptKeys = new Set();
  const layers = (plan.layers || []).map(layer => {
    const kept = [];
    for (const scenario of layer.scenarios || []) {
      const keep = descriptors.some(d => scenarioMatchesDescriptor(scenario, d));
      if (keep) {
        kept.push(scenario);
        keptKeys.add(scenario.id);
      } else {
        removed.push({ ...scenario, layer: layer.type });
      }
    }
    return { ...layer, scenarios: kept };
  });

  let scoped = normalizePlan({ ...plan, layers });
  const added = [];
  descriptors.forEach(d => {
    if (getPlanScenarios(scoped).some(s => scenarioMatchesDescriptor(s, d))) return;
    const documented = findDocumentedScenario(docs, d, moduleId);
    const scenario = documented || createTemporaryScenario(d, moduleId);
    const res = addScenarioToPlan(scoped, scenario, 'UI', 'ui');
    scoped = res.plan;
    if (res.changed) added.push(scenario);
  });

  return { plan: scoped, added, removed, changed: added.length > 0 || removed.length > 0 };
}

function refineCurrentPlan(plan, text) {
  if (!plan?.layers?.length) return { plan, removed: [], added: [], changed: false };

  const lower = String(text || '').toLowerCase();
  const removeLayerTypes = [];
  if (/\b(api|contract)\b/.test(lower) && /\b(layer|check|test|scenario|api)\b/.test(lower)) removeLayerTypes.push('API');
  if (/\b(data validation|data layer|data check)\b/.test(lower)) removeLayerTypes.push('DATA_VALIDATION');
  if (/\b(performance|perf)\b/.test(lower)) removeLayerTypes.push('PERFORMANCE');
  if (/\b(ui|browser)\b/.test(lower) && /\b(layer|check|test)\b/.test(lower)) removeLayerTypes.push('UI');

  const descriptors = requestedScenarioDescriptors(text);

  const removed = [];
  const refinedLayers = [];

  for (const layer of plan.layers) {
    if (removeLayerTypes.includes(layer.type)) {
      removed.push(...(layer.scenarios || []).map(s => ({ ...s, layer: layer.type })));
      continue;
    }

    const keptScenarios = (layer.scenarios || []).filter(s => {
      if (!descriptors.length) return true;
      const shouldRemove = descriptors.some(d => scenarioMatchesDescriptor(s, d));
      if (shouldRemove) removed.push({ ...s, layer: layer.type });
      return !shouldRemove;
    });

    if (keptScenarios.length) refinedLayers.push({ ...layer, scenarios: keptScenarios });
  }

  if (!removed.length) return { plan, removed, changed: false };

  const refinedPlan = {
    ...plan,
    layers: refinedLayers,
    recommended_order: (plan.recommended_order || []).filter(t => refinedLayers.some(l => l.type === t)),
  };
  if (!refinedPlan.recommended_order.length) refinedPlan.recommended_order = refinedLayers.map(l => l.type);
  refinedPlan.ui_only = refinedLayers.length ? refinedLayers.every(l => l.runner === 'ui') : plan.ui_only;

  return { plan: refinedPlan, removed, added: [], changed: true };
}

function speakPlanRefined(refinement) {
  const removedNames = (refinement.removed || []).map(s => s.name || s.id).filter(Boolean);
  const addedNames = (refinement.added || []).map(s => s.name || s.id).filter(Boolean);
  const parts = [];
  if (removedNames.length) parts.push(`removed **${removedNames.length === 1 ? removedNames[0] : `${removedNames.length} scenarios`}**`);
  if (addedNames.length) parts.push(`added **${addedNames.length === 1 ? addedNames[0] : `${addedNames.length} scenarios`}**`);
  const temp = (refinement.added || []).some(s => s.temporary) ? ' New scenarios are temporary until they pass and you choose to save them.' : '';
  return `Updated the plan and ${parts.join(' and ') || 'kept the requested scenarios'}. Review the planning workspace, then run the remaining checks when ready.${temp}`;
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

function appendScenarioToDocs(docsDir, scenario) {
  const file = path.join(process.cwd(), docsDir || './docs', `${scenario.module}.md`);
  if (!fs.existsSync(file)) throw new Error(`No docs file found for module "${scenario.module}".`);
  let content = fs.readFileSync(file, 'utf8');
  const line = `- ${scenario.id}: ${scenario.description || scenario.name || scenario.id}`;
  const section = content.match(/##\s*Test Scenarios\s*\n([\s\S]*?)(?=\n##|$)/i);
  if (section) {
    if (new RegExp(`[-*]\\s*${scenario.id}\\s*:`, 'i').test(section[1])) return false;
    const insertAt = section.index + section[0].length;
    const needsNewline = content[insertAt - 1] === '\n' ? '' : '\n';
    content = content.slice(0, insertAt) + needsNewline + line + '\n' + content.slice(insertAt);
  } else {
    content = content.replace(/\s*$/, '') + `\n\n## Test Scenarios\n${line}\n`;
  }
  fs.writeFileSync(file, content);
  return true;
}

function buildPlanFromTemporaryScenario(scenario, app) {
  const steps = Array.isArray(scenario.steps) && scenario.steps.length
    ? scenario.steps
    : [
        { action: 'navigate', value: '/testapp' },
        { action: 'click', selector: '#login-btn' },
        { action: 'expect', selector: '#error' },
      ];
  return {
    module: scenario.module,
    scenario: scenario.id,
    name: scenario.name,
    description: scenario.description,
    steps: injectUrl({ steps }, app.baseUrl).steps,
  };
}

function maybePromptTemporaryScenarioSave(ws, st, rpt) {
  const passed = (rpt.scenarios || []).filter(r =>
    r.scenario?.temporary &&
    (r.result?.status === 'success' || r.result?.status === 'pass')
  );
  if (!passed.length) return;

  st.pendingScenarioSaves = passed.map(r => {
    const key = scenarioKeyId(r.layer || 'UI', r.scenario);
    return {
      scenario: r.scenario,
      plan: st.temporaryScenarioPlans?.[key] || buildPlanFromTemporaryScenario(r.scenario, st.currentApp),
    };
  });

  const names = st.pendingScenarioSaves.map(p => p.scenario.name || p.scenario.id).join(', ');
  send(ws, 'temp_scenario_save_prompt', { scenarios: st.pendingScenarioSaves.map(p => p.scenario) });
  send(ws, 'chat_reply', {
    text: `The temporary scenario **${names}** passed. Save it to the module docs and reusable memory, or keep it only for this session?`,
    intent: 'TEMP_SAVE',
  });
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
async function getPlan(scenario, app, ws = null, options = {}) {
  const allowMemorySave = options.allowMemorySave !== false && !scenario?.temporary;
  const logGen = (text, level = 'info') => {
    console.log(`[getPlan] ${text}`);
    if (ws) send(ws, 'log', { text, level });
  };

  if (scenario?.temporary && Array.isArray(scenario.steps) && scenario.steps.length) {
    const plan = buildPlanFromTemporaryScenario(scenario, app);
    validatePlan(plan);
    logGen(`Prepared temporary plan: ${plan.module}/${plan.scenario} (${plan.steps.length} steps)`, 'info');
    return plan;
  }

  // 1. Memory cache — fast path
  const cached = allowMemorySave ? findSimilarPlan(scenario.module, scenario.id) : null;
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
  if (allowMemorySave) {
    saveToMemory(plan);
    logGen(`Generated & cached: ${plan.module}/${plan.scenario} (${plan.steps.length} steps)`, 'success');
  } else {
    logGen(`Generated temporary plan: ${plan.module}/${plan.scenario} (${plan.steps.length} steps)`, 'info');
  }
  return plan;
}

// ── Execute one scenario ──────────────────────────────────────────────────────
async function executeScenario(ws, plan, scenario, baseUrl, browser, appId = 'default', options = {}) {
  const allowMemorySave = options.allowMemorySave !== false && !scenario?.temporary;
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
        if (allowMemorySave) saveToMemory(fixedPlan);
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
    if (allowMemorySave) {
      saveToMemory(finalPlan);
      log(ws, `Cached: "${finalPlan.module}__${finalPlan.scenario}"`, 'success');
    } else {
      log(ws, `Temporary scenario kept in this session: "${finalPlan.module}__${finalPlan.scenario}"`, 'info');
    }
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
      if (newApp) { st.currentApp = newApp; st.lastRun = null; st.currentPlan = null; st.history = []; st.temporaryScenarioPlans = {}; st.pendingScenarioSaves = []; send(ws,'modules',loadModulesForApp(newApp)); send(ws,'chat_reply',{text:`Switched to **${newApp.name}**. Session reset — ready to test.`,intent:'system'}); }
      return;
    }

    if (type === 'edit_plan') {
      if (!st.currentPlan) {
        send(ws, 'chat_reply', { text: 'There is no active plan to edit yet. Ask me to create a test plan first.', intent: 'CLARIFY' });
        return;
      }
      const docs = loadAllDocs(st.currentApp.docsDir);
      const action = data?.action;
      let refinement = { plan: st.currentPlan, removed: [], added: [], changed: false };

      if (action === 'remove_scenario') {
        refinement = removeScenarioFromPlan(st.currentPlan, (scenario, layer) =>
          (!data.layerType || layer.type === data.layerType) &&
          String(scenario.module || '') === String(data.module || scenario.module || '') &&
          String(scenario.id || scenario.name || '') === String(data.scenarioId || '')
        );
      } else if (action === 'add_scenario') {
        const label = String(data.label || '').trim();
        const descriptor = requestedScenarioDescriptors(label)[0] || {
          id: slugify(label),
          name: titleCase(label),
          aliases: [label.toLowerCase()],
          description: data.description || `Temporary scenario for ${label}.`,
        };
        const documented = findDocumentedScenario(docs, descriptor, data.module || inferPlanModule(st.currentPlan));
        const scenario = documented || createTemporaryScenario(descriptor, data.module || inferPlanModule(st.currentPlan));
        const addResult = addScenarioToPlan(st.currentPlan, scenario, data.layerType || 'UI', data.runner || 'ui');
        refinement = { plan: addResult.plan, removed: [], added: addResult.changed ? [scenario] : [], changed: addResult.changed };
      }

      if (refinement.changed) {
        st.currentPlan = refinement.plan;
        const reply = speakPlanRefined(refinement);
        pushHistory(st, 'agent', reply);
        send(ws, 'test_plan_proposal', refinement.plan);
        send(ws, 'chat_reply', { text: reply, intent: 'PLAN' });
      }
      return;
    }

    if (type === 'save_temp_scenario') {
      const decision = String(data?.decision || '').toLowerCase();
      if (!st.pendingScenarioSaves?.length) {
        send(ws, 'chat_reply', { text: 'There is no passed temporary scenario waiting to be saved.', intent: 'TEMP_SAVE' });
        return;
      }
      if (decision === 'save') {
        const saved = [];
        for (const pending of st.pendingScenarioSaves) {
          appendScenarioToDocs(st.currentApp.docsDir, pending.scenario);
          saveToMemory({
            ...pending.plan,
            module: pending.scenario.module,
            scenario: pending.scenario.id,
          });
          saved.push(pending.scenario.name || pending.scenario.id);
        }
        st.pendingScenarioSaves = [];
        send(ws, 'modules', loadModulesForApp(st.currentApp));
        send(ws, 'chat_reply', { text: `Saved **${saved.join(', ')}** to the docs and reusable memory.`, intent: 'TEMP_SAVE' });
      } else {
        const kept = st.pendingScenarioSaves.map(p => p.scenario.name || p.scenario.id).join(', ');
        st.pendingScenarioSaves = [];
        send(ws, 'chat_reply', { text: `Kept **${kept}** as session-only. Docs and memory were not changed.`, intent: 'TEMP_SAVE' });
      }
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

      if (st.currentPlan && isPlanRefinementRequest(text)) {
        let refinement;
        if (isPlanOnlyRequest(text)) {
          refinement = applyOnlyScenarioScope(st.currentPlan, text, docs);
        } else if (isPlanAddRequest(text) && !isPlanRemoveRequest(text)) {
          const descriptor = requestedScenarioDescriptors(text)[0];
          if (!descriptor) {
            const reply = 'Which scenario should I add to the current plan?';
            pushHistory(st, 'agent', reply);
            send(ws, 'chat_reply', { text: reply, intent: 'CLARIFY' });
            send(ws, 'agent_state', 'idle');
            return;
          }
          const moduleId = inferPlanModule(st.currentPlan);
          const documented = findDocumentedScenario(docs, descriptor, moduleId);
          const scenario = documented || createTemporaryScenario(descriptor, moduleId);
          const added = addScenarioToPlan(st.currentPlan, scenario, 'UI', 'ui');
          refinement = { plan: added.plan, removed: [], added: added.changed ? [scenario] : [], changed: added.changed };
        } else {
          refinement = refineCurrentPlan(st.currentPlan, text);
        }
        if (refinement.changed) {
          st.currentPlan = refinement.plan;
          const reply = speakPlanRefined(refinement);
          pushHistory(st, 'agent', reply);
          send(ws, 'test_plan_proposal', refinement.plan);
          send(ws, 'chat_reply', { text: reply, intent: 'PLAN' });
          send(ws, 'agent_state', 'idle');
          return;
        }
      }

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
        if (isPlanOnlyRequest(text)) planResult = applyOnlyScenarioScope(planResult, text, docs).plan;
        const reply = speakPlanReady(planResult);
        st.currentPlan = planResult;
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
        let planResult = await planFeature(text, { ...st.currentApp, docs }, { lastRun: st.lastRun, appId: st.currentApp.id });
        if (isPlanOnlyRequest(text)) planResult = applyOnlyScenarioScope(planResult, text, docs).plan;
        st.currentPlan = planResult;
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
            validatePlan(plan);
            const scenario = {
              id: plan.scenario,
              name: plan.name,
              module: plan.module,
              description: plan.description || 'Custom temporary test',
              temporary: true,
              source: 'temporary',
              steps: plan.steps,
            };
            const active = st.currentPlan || { feature: `${titleCase(plan.module)} Temporary Scenario`, risk: 'medium', risk_reason: 'User-created scenario pending validation.', ui_only: true, layers: [], recommended_order: [] };
            const added = addScenarioToPlan(active, scenario, 'UI', 'ui');
            st.currentPlan = added.plan;
            const msg = `Created temporary scenario **${plan.name}** with ${plan.steps.length} steps. Review it in Current Plan, run it, then save it only if it passes and you want it for future use.`;
            pushHistory(st, 'agent', msg);
            send(ws, 'chat_reply', { text: msg, intent: 'DISCUSS' });
            send(ws, 'test_plan_proposal', st.currentPlan);
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
          const allowMemorySave = !scenarioWithRunner.temporary;
          send(ws, 'scenario_start', scenarioWithRunner);
          planProgress(ws, { layer: layer.type, scenario: scenarioWithRunner, status: 'running' });

          if (layer.runner === 'ui') {
            // Standard Playwright execution
            let browser = null;
            try {
              const p = await getPlan(scenarioWithRunner, runApp, ws, { allowMemorySave });
              if (scenarioWithRunner.temporary) {
                st.temporaryScenarioPlans[scenarioKeyId(layer.type, scenarioWithRunner)] = p;
              }
              browser = await chromium.launch({ headless: false });
              const { result, healCount, healMeta } = await executeScenario(ws, p, scenarioWithRunner, runApp.baseUrl, browser, runApp.id, { allowMemorySave });
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
      maybePromptTemporaryScenarioSave(ws, st, rpt);
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
