/**
 * runners/ui-runner.js
 *
 * UI test runner — wraps executor.js (Playwright) into the unified Runner interface.
 * This is what the existing QA Sentinel uses for all browser automation tests.
 *
 * Unified RunResult shape (all runners return this):
 * {
 *   runnerId:  'ui' | 'api' | 'data' | 'perf',
 *   status:    'pass' | 'fail' | 'skip',
 *   scenario:  { id, name, module, description },
 *   steps:     [{ index, action, target, status, error?, duration }],
 *   summary:   { total, passed, failed, duration },
 *   artifacts: { screenshots?: [], logs: [] },
 *   healMeta:  null | { from, to, diff },
 * }
 */

import { chromium } from 'playwright';

export const RUNNER_ID = 'ui';

export async function run(scenario, config = {}) {
  const { steps, baseUrl, headless = false, onStep, onLog } = config;
  if (!steps?.length) {
    return makeResult(scenario, 'skip', [], 0, ['No steps provided']);
  }

  const start    = Date.now();
  const results  = [];
  const logs     = [];
  const addLog   = (text, level = 'info') => { logs.push({ text, level, ts: Date.now() }); onLog?.(text, level); };

  const browser = await chromium.launch({ headless });
  const ctx     = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page    = await ctx.newPage();
  page.setDefaultTimeout(10000);

  let status = 'pass';
  let failPage = null;

  try {
    for (let i = 0; i < steps.length; i++) {
      const step    = steps[i];
      const stepStart = Date.now();
      onStep?.(i, step, 'running');
      addLog(`Step ${i+1}: ${step.action} ${step.selector || step.value || ''}`);

      try {
        await executeStep(page, step, baseUrl);
        const duration = Date.now() - stepStart;
        results.push({ index: i, action: step.action, target: step.selector || step.value || '', status: 'pass', duration });
        onStep?.(i, step, 'success');
      } catch (e) {
        const duration = Date.now() - stepStart;
        status = 'fail';
        addLog(`Step ${i+1} failed: ${e.message}`, 'error');
        results.push({ index: i, action: step.action, target: step.selector || step.value || '', status: 'fail', error: e.message, duration });
        onStep?.(i, step, 'failed');
        failPage = page; // keep reference for live DOM capture
        break;
      }
    }
  } finally {
    await ctx.close();
    await browser.close();
  }

  const duration = Date.now() - start;
  return makeResult(scenario, status, results, duration, logs, failPage);
}

async function executeStep(page, step, baseUrl) {
  switch (step.action.toLowerCase()) {
    case 'navigate':
    case 'goto': {
      const url = step.value.startsWith('http') ? step.value : `${baseUrl}${step.value}`;
      await page.goto(url, { waitUntil: 'networkidle' });
      break;
    }
    case 'click':
      await page.click(step.selector, { timeout: 5000 });
      break;
    case 'type':
    case 'fill':
      await page.waitForSelector(step.selector, { state: 'visible' });
      await page.fill(step.selector, step.value);
      break;
    case 'expect':
    case 'assert':
      if (step.value) await page.waitForSelector(`${step.selector}:has-text("${step.value}")`, { state: 'visible' });
      else await page.waitForSelector(step.selector, { state: 'visible' });
      break;
    case 'expecturl':
    case 'verifyurl': {
      const expected = step.value.startsWith('http') ? step.value : `${baseUrl}${step.value}`;
      await page.waitForURL(url => url.toString().toLowerCase().includes(expected.toLowerCase()), { timeout: 7000 });
      break;
    }
    case 'asserttext': {
      await page.waitForSelector(step.selector, { state: 'visible' });
      const content = await page.textContent(step.selector);
      if (!content?.includes(step.value)) throw new Error(`Expected "${step.value}" in "${content?.slice(0,60)}"`);
      break;
    }
    case 'waitfornavigation':
      await page.waitForLoadState('networkidle', { timeout: 10000 });
      break;
    case 'wait':
      if (!isNaN(step.value)) await page.waitForTimeout(parseInt(step.value));
      else await page.waitForSelector(step.value);
      break;
    default:
      throw new Error(`Unknown action: ${step.action}`);
  }
}

function makeResult(scenario, status, steps, duration, logs = [], _failPage = null) {
  const passed = steps.filter(s => s.status === 'pass').length;
  const failed = steps.filter(s => s.status === 'fail').length;
  return {
    runnerId: RUNNER_ID,
    status,
    scenario,
    steps,
    summary: { total: steps.length, passed, failed, duration },
    artifacts: { logs },
    healMeta: null,
  };
}