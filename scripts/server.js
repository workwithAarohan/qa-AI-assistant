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

import { generateAllScenarioSteps, fixSteps } from './agent.js';
import { runSteps } from './executor.js';
import { validatePlan } from './validator.js';
import { saveToMemory, findSimilarPlan, listMemory, repairMemory } from './memory.js';
import { loadAllDocs } from './context.js';
import { captureBrowserContext } from './browser-context.js';
import { classifyFailure, DECISION_META } from './failure-classifier.js';
import { guardCheck, IDENTITY_ANCHOR } from './guard.js';
import { generate as llm } from './llm.js';

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
function getState(ws) {
  if (!connState.has(ws)) connState.set(ws, { currentApp: loadApps()[0], lastRun: null });
  return connState.get(ws);
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

// ── Helpers ───────────────────────────────────────────────────────────────────
const send  = (ws, type, data) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type, data })); };
const log   = (ws, text, level = 'info') => { console.log(`[${level}] ${text}`); send(ws, 'log', { text, level }); };
const phase = (ws, text) => send(ws, 'log', { text, level: 'phase' });

function waitForHealAnswer(ws, ms = 1_800_000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.off('message', h); reject(new Error('Timeout')); }, ms);
    function h(raw) { try { const m = JSON.parse(raw); if (m.type === 'heal_answer') { clearTimeout(t); ws.off('message', h); resolve(m.data); } } catch {} }
    ws.on('message', h);
  });
}

function injectUrl(plan, baseUrl) {
  if (!baseUrl || !plan?.steps) return plan;
  return { ...plan, steps: plan.steps.map(s => s.action === 'navigate' && s.value && !s.value.startsWith('http') ? { ...s, value: baseUrl + (s.value.startsWith('/') ? s.value : '/' + s.value) } : s) };
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
async function getPlan(scenario, app) {
  const cached = findSimilarPlan(scenario.module, scenario.id);
  if (cached) return cached;
  const docs = loadAllDocs(app.docsDir);
  const docCtx = docs.find(d => d.name === scenario.module)?.content || '';
  const browserCtx = await captureBrowserContext(app.baseUrl).catch(() => '');
  const batch = await generateAllScenarioSteps([scenario], docCtx, browserCtx);
  const plan = batch[0];
  validatePlan(plan);
  saveToMemory(plan);
  return plan;
}

// ── Execute one scenario ──────────────────────────────────────────────────────
async function executeScenario(ws, plan, scenario, baseUrl, browser) {
  const finalPlan = injectUrl(plan, baseUrl);
  send(ws, 'execution_plan', { ...finalPlan, scenarioId: scenario.id });
  let liveDom = null, liveUrl = null;

  let result = await runSteps(finalPlan.steps, {
    browser, baseUrl,
    onStep:  (i, s, st) => send(ws, 'step', { index: i, status: st }),
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
        onStep: (i,s,st) => send(ws,'step',{index:i,status:st}),
        onLog:  (t,l) => log(ws,t,l),
        onFail: async (page) => { try { liveUrl=page.url(); liveDom=await captureLiveDom(page); } catch {} },
      });
      healCount++;
      if (result.status === 'success') {
        log(ws, 'Heal succeeded ✓', 'success');
        saveToMemory(fixedPlan);
        healMeta = { failedStep: failedSR?.step??null, failedIndex: fi, fixedStep: fixedPlan.steps[fi]??null, diff, classification: clf };
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

// ── Chat intent ───────────────────────────────────────────────────────────────
const POST_RUN_P = [/\b(why|what|how|explain|root cause).*(fail|broke|error|issue|wrong)\b/i,/\b(what|how).*(heal|fix|change)\b/i,/\bstep \d+\b/i,/\b(last|previous).*(run|test|result)\b/i,/\b(what changed|what happened)\b/i];
const DISCOVER_P = [/\b(what|list|show|tell).*(module|scenario|test|can (i|we) test)\b/i,/\b(describe|explain|about).*(module|login|dashboard|profile|project|navigation)\b/i,/\b(what scenarios?|which tests?|how (do|can) (i|we) test)\b/i];
const BUILD_P    = [/\b(create|add|build|generate|make).*(test|scenario|flow)\b/i,/\b(custom test|new scenario|test that)\b/i];

async function classifyChat(text, hasLastRun, docs) {
  const l = text.toLowerCase().trim();
  if (POST_RUN_P.some(p=>p.test(l)) && hasLastRun) return 'POST_RUN';
  if (DISCOVER_P.some(p=>p.test(l))) return 'DISCOVER';
  if (BUILD_P.some(p=>p.test(l))) return 'BUILD';
  if (/^(hi|hello|hey)\b/.test(l)) return 'GREET';

  const prompt = `${IDENTITY_ANCHOR}
User: "${text}"
Modules: ${docs.map(d=>d.name).join(', ')}
Has recent test run: ${hasLastRun}
Classify into ONE: DISCOVER | POST_RUN | BUILD | GREET | OUT_OF_SCOPE
Return only the word.`;
  try {
    const r = await llm(prompt, { maxAttempts: 1 });
    const t = r.response.text().trim().toUpperCase();
    if (['DISCOVER','POST_RUN','BUILD','GREET','OUT_OF_SCOPE'].includes(t)) return t;
  } catch {}
  return 'DISCOVER';
}

function discoverReply(text, app, docs) {
  const l = text.toLowerCase();
  const matched = docs.find(d => l.includes(d.name.toLowerCase()));
  if (matched) {
    const sec = matched.content.match(/##\s*Test Scenarios\s*\n([\s\S]*?)(?=\n##|$)/i);
    const scenes = sec ? sec[1].trim().split('\n').map(line => { const m=line.match(/[-*]\s*([a-z_]+):\s*(.+)/i); return m?`• **${m[1].replace(/_/g,' ')}** — ${m[2].trim()}`:null; }).filter(Boolean) : [];
    const desc = matched.content.match(/##\s*Description\s*\n([\s\S]*?)(?=\n##|$)/i)?.[1]?.trim().split('\n')[0]||'';
    const url  = matched.content.match(/##\s*URL\s*\n(https?:\/\/[^\s]+)/i)?.[1]||'';
    return `**${matched.name.charAt(0).toUpperCase()+matched.name.slice(1)}**${url?` — ${url}`:''}\n${desc?desc+'\n':''}\n${scenes.length?'Scenarios:\n'+scenes.join('\n')+'\n\nUse the dashboard to run any scenario.':'No scenarios documented yet.'}`;
  }
  const list = docs.map(d => { const s=d.content.match(/##\s*Test Scenarios\s*\n([\s\S]*?)(?=\n##|$)/i); const n=s?(s[1].match(/[-*]\s*[a-z_]+:/gi)||[]).length:0; return `• **${d.name}** — ${n} scenario${n!==1?'s':''}`; }).join('\n');
  return `**${app.name}** has ${docs.length} modules:\n\n${list}\n\nAsk about any module, or run tests from the dashboard.`;
}

async function postRunReply(text, lastRun) {
  if (!lastRun) return "No test run yet. Run a test from the dashboard first.";
  const { scenarios=[], summary={} } = lastRun;
  const detail = scenarios.map(s => {
    const failed = (s.result?.results||[]).find(r=>r.status==='failed');
    return [`${s.scenario?.name} [${s.scenario?.module}] — ${(s.result?.status||'unknown').toUpperCase()}`, failed?`  Failed step ${s.result.results.indexOf(failed)+1}: ${failed.step?.action} ${failed.step?.selector||''} — ${failed.error||''}`:null, s.healCount>0?`  Healed: ${s.healMeta?.fixedStep?.selector||'updated'}`:null].filter(Boolean).join('\n');
  }).join('\n\n');
  const prompt = `${IDENTITY_ANCHOR}
Question: "${text}"
Last run: Total ${summary.total} | Passed ${summary.passed} | Failed ${summary.failed} | Healed ${summary.healed}
${detail}
Answer in 2-4 sentences. Be specific and direct. No filler.`;
  try { const r = await llm(prompt,{maxAttempts:1}); return r.response.text().trim(); } catch {
    return `Last run: ${summary.total} total — ${summary.passed} passed, ${summary.failed} failed, ${summary.healed} healed.`;
  }
}

async function buildScenario(text, app, docs) {
  const docCtx = docs.map(d=>`### ${d.name}\n${d.content}`).join('\n\n').slice(0,3000);
  const prompt = `${IDENTITY_ANCHOR}
User wants a custom test: "${text}"
App: ${app.name} (${app.baseUrl})
Docs:\n${docCtx}
Return ONLY valid JSON:
{"name":"short name","description":"one sentence","module":"module_name","id":"snake_case_id","steps":[{"action":"navigate","value":"http://..."},{"action":"type","selector":"#id","value":"text"},{"action":"click","selector":"#id"},{"action":"expect","selector":"#id"}]}`;
  try {
    const r = await llm(prompt,{maxAttempts:1});
    const txt = r.response.text().replace(/```json|```/g,'').trim();
    const match = txt.match(/\{[\s\S]*\}/);
    if (match) {
      const plan = JSON.parse(match[0]);
      plan.module   = plan.module   || 'custom';
      plan.scenario = plan.id       || plan.name.toLowerCase().replace(/\s+/g,'_');
      validatePlan(plan); saveToMemory(plan);
      return { plan, message:`Created **${plan.name}** — ${plan.steps.length} steps added to dashboard under "${plan.module}".` };
    }
  } catch {}
  return { plan: null, message: "Couldn't generate that. Try: *'Create a test that logs in and verifies the project count'*" };
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

    // Switch app
    if (type === 'set_app') {
      const newApp = getApp(data);
      if (newApp) { st.currentApp = newApp; st.lastRun = null; send(ws,'modules',loadModulesForApp(newApp)); send(ws,'chat_reply',{text:`Switched to **${newApp.name}**. Dashboard refreshed.`,intent:'system'}); }
      return;
    }

    // Chat
    if (type === 'chat') {
      const text = (data||'').trim(); if (!text) return;
      const g = guardCheck(text); if (!g.safe) { send(ws,'chat_reply',{text:g.reason,intent:'error'}); return; }
      send(ws,'agent_state','thinking');
      const docs = loadAllDocs(st.currentApp.docsDir);
      const intent = await classifyChat(text, !!st.lastRun, docs);
      let reply = '';
      switch(intent) {
        case 'GREET':
          reply = `Hi! I'm your QA partner for **${st.currentApp.name}**.\n\nAsk me:\n• *"What can I test in the login module?"*\n• *"Why did step 5 fail?"*\n• *"Create a test that verifies the dashboard loads"*\n\nRun tests from the dashboard.`;
          break;
        case 'DISCOVER':
          reply = discoverReply(text, st.currentApp, docs); break;
        case 'POST_RUN':
          reply = await postRunReply(text, st.lastRun); break;
        case 'BUILD': {
          const { plan, message } = await buildScenario(text, st.currentApp, docs);
          reply = message;
          if (plan) send(ws,'new_custom_scenario',{id:plan.scenario||plan.id,name:plan.name,description:plan.description||'Custom test',module:plan.module});
          break;
        }
        default:
          reply = "I can help with: exploring modules, analyzing test failures, or building custom scenarios.";
      }
      send(ws,'chat_reply',{text:reply,intent}); send(ws,'agent_state','idle'); return;
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
        const plan = await getPlan(scenario, runApp);
        browser = await chromium.launch({ headless: false });
        const { result, healCount, healMeta } = await executeScenario(ws, plan, scenario, runApp.baseUrl, browser);
        const rpt = { status:result.status, healCount, scenarios:[{scenario,result,healCount,healMeta}], summary:{total:1,passed:(result.status==='success'&&!healCount)?1:0,failed:result.status==='failed'?1:0,skipped:0,healed:healCount} };
        send(ws,'report',rpt); st.lastRun = rpt;
      } catch(e) { log(ws,e.message,'error'); send(ws,'execution_error',e.message); }
      finally { if(browser) await browser.close(); send(ws,'agent_state','idle'); }
      return;
    }

    // Run full module
    if (type === 'run_module') {
      const { module: modId } = data;
      const runApp = st.currentApp;
      send(ws,'agent_state','running'); send(ws,'execution_start',{module:modId,scenario:'all',app:runApp.name});
      const docs = loadAllDocs(runApp.docsDir);
      const doc = docs.find(d=>d.name===modId);
      const sec = doc?.content.match(/##\s*Test Scenarios\s*\n([\s\S]*?)(?=\n##|$)/i);
      const scenarios = sec ? sec[1].trim().split('\n').map(l=>{const m=l.match(/[-*]\s*([a-z_]+):\s*(.+)/i);return m?{id:m[1].toLowerCase(),name:m[1].replace(/_/g,' '),description:m[2].trim(),module:modId}:null;}).filter(Boolean) : [];
      if(!scenarios.length){send(ws,'chat_reply',{text:`No scenarios for "${modId}".`,intent:'warn'});send(ws,'agent_state','idle');return;}
      const results=[]; let healed=0, browser=null;
      try {
        browser = await chromium.launch({headless:false});
        for(const s of scenarios){
          phase(ws,`── ${s.name} ──`); send(ws,'scenario_start',s);
          try { const plan=await getPlan(s,runApp); const {result,healCount,healMeta}=await executeScenario(ws,plan,s,runApp.baseUrl,browser); results.push({scenario:s,result,healCount,healMeta}); healed+=healCount; }
          catch(e){ log(ws,`${s.name}: ${e.message}`,'error'); results.push({scenario:s,result:{status:'skipped',results:[]},healCount:0,healMeta:null}); }
          await new Promise(r=>setTimeout(r,300));
        }
      } finally { if(browser) await browser.close(); }
      const passed=results.filter(r=>r.result.status==='success'&&!r.healCount).length, failed=results.filter(r=>r.result.status==='failed').length, skipped=results.filter(r=>r.result.status==='skipped').length;
      const rpt={status:failed===0?'success':'failed',healCount:healed,scenarios:results,summary:{total:results.length,passed,failed,skipped,healed}};
      send(ws,'report',rpt); st.lastRun=rpt; send(ws,'agent_state','idle'); return;
    }

    // Run regression
    if (type === 'run_regression') {
      const runApp = st.currentApp;
      send(ws,'agent_state','running'); send(ws,'execution_start',{module:'all',scenario:'regression',app:runApp.name});
      const docs = loadAllDocs(runApp.docsDir);
      const all = [];
      docs.forEach(d=>{const sec=d.content.match(/##\s*Test Scenarios\s*\n([\s\S]*?)(?=\n##|$)/i);if(!sec)return;sec[1].trim().split('\n').forEach(l=>{const m=l.match(/[-*]\s*([a-z_]+):\s*(.+)/i);if(m)all.push({id:m[1].toLowerCase(),name:m[1].replace(/_/g,' '),description:m[2].trim(),module:d.name});});});
      const results=[]; let healed=0, browser=null;
      try {
        browser=await chromium.launch({headless:false});
        for(const s of all){
          phase(ws,`── ${s.module}/${s.name} ──`); send(ws,'scenario_start',s);
          try{const plan=await getPlan(s,runApp);const {result,healCount,healMeta}=await executeScenario(ws,plan,s,runApp.baseUrl,browser);results.push({scenario:s,result,healCount,healMeta});healed+=healCount;}
          catch(e){log(ws,`${s.name}: ${e.message}`,'error');results.push({scenario:s,result:{status:'skipped',results:[]},healCount:0,healMeta:null});}
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
  try { const r=repairMemory(); console.log(`[Memory] ${r.total} plans, ${r.changed} repaired.`); } catch {}
});