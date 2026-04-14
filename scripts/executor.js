import { chromium } from 'playwright';

async function smartClick(page, step) {
  try {
    await page.click(step.selector, { timeout: 5000 });
    return 'primary';
  } catch {
    // fallback: try by visible text if step has a label hint
    if (step.label) {
      try {
        await page.getByText(step.label, { exact: false }).click();
        return 'text-fallback';
      } catch {}
    }
    // fallback: try by role
    if (step.role) {
      try {
        await page.getByRole(step.role, { name: step.label || step.selector }).click();
        return 'role-fallback';
      } catch {}
    }
    throw new Error(`Could not click: ${step.selector}`);
  }
}

export async function runSteps(steps, onStep = () => {}) {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  const results = [];

  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      let methodUsed = 'primary';

      try {
        // notify running, no screenshot yet
        onStep(i, step, 'running', null);
        console.log(`[Step ${i + 1}] ${step.action}`, step.selector || step.value || '');

        switch (step.action) {

          case 'navigate':
            await page.goto(step.value, { waitUntil: 'domcontentloaded', timeout: 10000 });
            break;

          case 'type':
            await page.waitForSelector(step.selector, { timeout: 5000 });
            await page.fill(step.selector, step.value);
            break;

          case 'click':
            methodUsed = await smartClick(page, step);
            break;

          case 'expect':
            await page.waitForSelector(step.selector, { state: 'visible', timeout: 5000 });
            break;

          case 'expectUrl':
            await page.waitForURL(`**${step.value}**`, { timeout: 8000 });
            break;

          case 'waitForNavigation':
            await page.waitForLoadState('domcontentloaded', { timeout: 10000 });
            break;

          case 'wait':
            await page.waitForTimeout(Number(step.value) || 1000);
            break;

          case 'assertText':
            await page.waitForSelector(step.selector, { timeout: 5000 });
            const text = await page.textContent(step.selector);
            if (!text?.includes(step.value)) {
              throw new Error(`Expected text "${step.value}" not found in "${step.selector}"`);
            }
            break;

          case 'screenshot':
            await page.screenshot({ path: step.value || `screenshot-${Date.now()}.png` });
            break;

          default:
            throw new Error(`Unknown action: ${step.action}`);
        }

        // capture screenshot for UI/LLM context
        let screenshotB64 = null;
        try {
          const buf = await page.screenshot({ type: 'png' });
          screenshotB64 = buf.toString('base64');
        } catch (err) {}

        results.push({ index: i, step, status: 'success', methodUsed });
        onStep(i, step, 'success', screenshotB64);

        // small pause so the UI dot visibly turns green before the next step
        await new Promise(r => setTimeout(r, 500));

      } catch (err) {
        // try to capture a screenshot on failure
        let failB64 = null;
        try {
          const buf = await page.screenshot({ type: 'png' });
          failB64 = buf.toString('base64');
        } catch (e) {}

        results.push({ index: i, step, status: 'failed', error: err.message });
        onStep(i, step, 'failed', failB64);

        await browser.close();
        return {
          status: 'failed',
          failedStep: step,
          failedIndex: i,
          error: err.message,
          results,
        };
      }
    }

    await browser.close();
    return { status: 'success', results };

  } catch (err) {
    try { await browser.close(); } catch {}
    return { status: 'failed', error: err.message, results };
  }
}