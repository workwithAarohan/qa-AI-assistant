import { chromium } from 'playwright';

/**
 * Helper: Smart Click
 * Tries the primary selector, then falls back to text or roles 
 * if the primary selector fails.
 */
async function smartClick(page, step) {
  try {
    // Primary attempt
    await page.click(step.selector, { timeout: 3000 });
    return 'primary';
  } catch {
    // Fallback 1: Try by visible text
    if (step.label || step.value) {
      try {
        const textToFind = step.label || step.value;
        await page.getByText(textToFind, { exact: false }).click({ timeout: 2000 });
        return 'text-fallback';
      } catch {}
    }
    // Fallback 2: Try by role (Button, Link, etc.)
    try {
      await page.locator(`role=button[name="${step.selector}"]`).click({ timeout: 2000 });
      return 'role-fallback';
    } catch {}
    
    throw new Error(`Selector not found or not clickable: ${step.selector}`);
  }
}

/**
 * Main Execution Engine
 */
export async function runSteps(steps, { browser, baseUrl, onStep, onLog, onFail }) {
  let internalBrowser = browser;
  let ownsBrowser = false;
 
  if (!internalBrowser) {
    internalBrowser = await chromium.launch({ headless: false });
    ownsBrowser = true;
  }
 
  const context = await internalBrowser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: 'QA-Agent-Bot/1.0',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
 
  const results = [];
  let status = 'success';
  let error = null;
 
  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (onStep) onStep(i, step, 'running');
      if (onLog)  onLog(`Step ${i + 1}: ${step.action} ${step.selector || step.value || ''}`, 'info');
 
      try {
        switch (step.action.toLowerCase()) {
          case 'navigate':
          case 'goto': {
            const url = step.value.startsWith('http') ? step.value : `${baseUrl}${step.value}`;
            await page.goto(url, { waitUntil: 'networkidle' });
            break;
          }
          case 'click': {
            const clickType = await smartClick(page, step);
            if (clickType !== 'primary' && onLog) onLog(`Used ${clickType} for: ${step.selector}`, 'warn');
            break;
          }
          case 'type':
          case 'fill':
            await page.waitForSelector(step.selector, { state: 'visible' });
            await page.fill(step.selector, step.value);
            break;
          case 'press':
            await page.press(step.selector, step.value);
            break;
          case 'wait':
            if (!isNaN(step.value)) await page.waitForTimeout(parseInt(step.value));
            else await page.waitForSelector(step.value);
            break;
          case 'expecturl':
          case 'verifyurl': {
            const expected = step.value.startsWith('http') ? step.value : `${baseUrl}${step.value}`;
            await page.waitForURL(url => {
              const cur = url.toString().toLowerCase();
              const tgt = expected.toLowerCase();
              return cur.includes(tgt) || tgt.includes(cur);
            }, { timeout: 7000 });
            break;
          }
          case 'verify':
          case 'assert':
          case 'expect':
            if (step.value) await page.waitForSelector(`${step.selector}:has-text("${step.value}")`, { state: 'visible' });
            else await page.waitForSelector(step.selector, { state: 'visible' });
            break;
          case 'waitfornavigation':
            await page.waitForLoadState('networkidle', { timeout: 10000 });
            break;
          case 'asserttext': {
            await page.waitForSelector(step.selector, { state: 'visible' });
            const content = await page.textContent(step.selector);
            if (!content.includes(step.value)) {
              throw new Error(`Text validation failed. Expected "${step.value}" but found "${content}"`);
            }
            break;
          }
          default:
            throw new Error(`Unknown action: ${step.action}`);
        }
 
        results.push({ index: i, step, status: 'success' });
        if (onStep) onStep(i, step, 'success');
 
      } catch (stepError) {
        status = 'failed';
        error  = stepError.message;
        const detail = `Step ${i} (${step.action}) failed: ${stepError.message}`;
 
        results.push({ index: i, step, status: 'failed', error: detail });
        if (onStep) onStep(i, step, 'failed');
        if (onLog)  onLog(detail, 'error');
 
        // ── KEY: call onFail with live page BEFORE closing context ────────────
        if (onFail) {
          try { await onFail(page); } catch (e) { /* non-fatal */ }
        }
 
        break;
      }
    }
  } finally {
    await page.waitForTimeout(800);
    await context.close();
    if (ownsBrowser) await internalBrowser.close();
  }
 
  return { status, results, error };
}