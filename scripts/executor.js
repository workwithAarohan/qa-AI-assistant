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

export async function runSteps(steps, { browser, baseUrl, onStep, onLog }) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: 'QA-Agent-Bot/1.0'
  });
  
  const page = await context.newPage();
  
  // Optimization: Lower timeouts for a snappier "Live" feel
  // Default is 30s; 10s is plenty for a healthy local/dev app.
  page.setDefaultTimeout(10000); 

  const results = [];
  let status = 'success';
  let error = null;

  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      
      // Notify UI that this specific step is now running
      if (onStep) onStep(i, step, 'running');
      if (onLog) onLog(`Executing: ${step.action} ${step.selector || step.value || ''}`, 'info');

      try {
        switch (step.action.toLowerCase()) {
          case 'navigate':
            const targetUrl = step.value.startsWith('http') ? step.value : `${baseUrl}${step.value}`;
            await page.goto(targetUrl, { waitUntil: 'networkidle' });
            break;

          case 'click':
            await page.click(step.selector);
            break;

          case 'type':
          case 'fill':
            await page.fill(step.selector, step.value);
            break;

          case 'press':
            await page.press(step.selector, step.value);
            break;

          case 'wait':
            // If value is a number, wait for ms; otherwise wait for selector
            if (!isNaN(step.value)) {
              await page.waitForTimeout(parseInt(step.value));
            } else {
              await page.waitForSelector(step.value);
            }
            break;

          case 'verify':
          case 'assert':
            // Check if element contains text or simply exists
            if (step.value) {
              const content = await page.textContent(step.selector);
              if (!content.includes(step.value)) {
                throw new Error(`Expected text "${step.value}" not found in ${step.selector}`);
              }
            } else {
              await page.waitForSelector(step.selector, { state: 'visible' });
            }
            break;

          default:
            throw new Error(`Unknown action: ${step.action}`);
        }

        // Mark step as passed
        results.push({ index: i, step, status: 'success' });
        if (onStep) onStep(i, step, 'success');

      } catch (stepError) {
        // --- STEP FAILURE LOGIC ---
        status = 'failed';
        error = stepError.message;
        
        // Detailed error for the Auto-heal engine
        const failureDetail = `Step ${i} (${step.action}) failed: ${stepError.message}`;
        
        results.push({ index: i, step, status: 'failed', error: failureDetail });
        if (onStep) onStep(i, step, 'failed');
        if (onLog) onLog(failureDetail, 'error');

        // Stop execution on first failure
        break; 
      }
    }
  } finally {
    // Keep the browser open for a second so the user sees the final state
    await page.waitForTimeout(1000);
    await context.close();
  }

  return { status, results, error };
}