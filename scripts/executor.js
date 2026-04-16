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
export async function runSteps(steps, { browser, baseUrl, onStep, onLog }) {
  let internalBrowser = browser;
  let ownsBrowser = false;

  // 1. HYBRID CHECK: If no browser provided, launch one locally
  if (!internalBrowser) {
    if (onLog) onLog('Executor: No browser provided, launching internal instance...', 'info');
    internalBrowser = await chromium.launch({ headless: false });
    ownsBrowser = true;
  }

  // 2. Setup Context & Page
  const context = await internalBrowser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: 'QA-Agent-Bot/1.0'
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
      if (onLog) onLog(`Step ${i + 1}: ${step.action} ${step.selector || step.value || ''}`, 'info');

      try {
        switch (step.action.toLowerCase()) {
          case 'navigate':
            const targetUrl = step.value.startsWith('http') ? step.value : `${baseUrl}${step.value}`;
            await page.goto(targetUrl, { waitUntil: 'networkidle' });
            break;

          case 'click':
            // Using the smartClick helper for better reliability
            const clickType = await smartClick(page, step);
            if (clickType !== 'primary' && onLog) {
              onLog(`Used ${clickType} for: ${step.selector}`, 'warn');
            }
            break;

          case 'type':
          case 'fill':
            await page.waitForSelector(step.selector, { state: 'visible' });
            await page.fill(step.selector, step.value);
            break;

          case 'press':
            await page.press(step.selector, step.value);
            break;

          case 'wait':
            if (!isNaN(step.value)) {
              await page.waitForTimeout(parseInt(step.value));
            } else {
              await page.waitForSelector(step.value);
            }
            break;

          case 'verify':
          case 'assert':
          case 'expect':
            if (step.value) {
              // Wait for text to appear in the element
              await page.waitForSelector(`${step.selector}:has-text("${step.value}")`, { state: 'visible' });
            } else {
              await page.waitForSelector(step.selector, { state: 'visible' });
            }
            break;

          default:
            throw new Error(`Unknown action: ${step.action}`);
        }

        results.push({ index: i, step, status: 'success' });
        if (onStep) onStep(i, step, 'success');

      } catch (stepError) {
        status = 'failed';
        error = stepError.message;
        const failureDetail = `Step ${i} (${step.action}) failed: ${stepError.message}`;
        
        results.push({ index: i, step, status: 'failed', error: failureDetail });
        if (onStep) onStep(i, step, 'failed');
        if (onLog) onLog(failureDetail, 'error');
        break; 
      }
    }
  } finally {
    // Keep visible for a moment for the user
    await page.waitForTimeout(1500);
    await context.close();
    
    // 3. ONLY close the browser if we launched it here
    if (ownsBrowser) {
      await internalBrowser.close();
    }
  }

  return { status, results, error };
}