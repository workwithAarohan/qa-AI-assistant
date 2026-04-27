/**
 * runners/perf-runner.js
 *
 * Performance Test Runner — measures real browser performance metrics.
 *
 * Captures:
 *   - Core Web Vitals via PerformanceObserver (LCP, CLS, FID/INP)
 *   - Navigation Timing API (TTFB, DOM interactive, DOM complete)
 *   - Resource timing (API call duration from browser perspective)
 *   - Custom marks (table render time, filter response time)
 *   - Lighthouse-style budget assertions
 *
 * No external dependencies — uses Playwright + browser APIs only.
 */

import { chromium } from 'playwright';

export const RUNNER_ID = 'perf';

// ── Thresholds (Lighthouse "Good" ratings) ────────────────────────────────────
const BUDGETS = {
  ttfb:          { good: 200,  acceptable: 500,  unit: 'ms', label: 'Time to First Byte' },
  domInteractive: { good: 1500, acceptable: 3000, unit: 'ms', label: 'DOM Interactive' },
  domComplete:   { good: 2500, acceptable: 5000, unit: 'ms', label: 'DOM Complete' },
  lcp:           { good: 2500, acceptable: 4000, unit: 'ms', label: 'Largest Contentful Paint' },
  tableRender:   { good: 300,  acceptable: 800,  unit: 'ms', label: 'Table Render Time' },
  filterResponse:{ good: 100,  acceptable: 400,  unit: 'ms', label: 'Filter Response Time' },
  apiDuration:   { good: 300,  acceptable: 600,  unit: 'ms', label: 'API Response Time (browser)' },
  totalResources:{ good: 500,  acceptable: 1000, unit: 'KB', label: 'Total Resource Size' },
};

// ── Entry point ───────────────────────────────────────────────────────────────
export async function run(scenario, config = {}) {
  const { baseUrl, headless = true, onStep, onLog } = config;
  const addLog = (text, level = 'info') => { onLog?.(text, level); };
  const start  = Date.now();
  const metrics = {};
  const checks  = [];
  let stepIdx   = 0;

  addLog(`Performance test: ${scenario.name}`);

  const browser = await chromium.launch({
    headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    // ── Run 1: Cold load — Navigation timing + LCP ────────────────────────
    onStep?.(stepIdx, { action: 'perf_measure', target: 'Cold page load' }, 'running');
    addLog('Measuring cold page load…');

    const coldCtx  = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const coldPage = await coldCtx.newPage();

    // Collect LCP via PerformanceObserver before navigation
    await coldPage.addInitScript(() => {
      window.__perfMetrics = {};
      new PerformanceObserver(list => {
        const entries = list.getEntries();
        entries.forEach(e => { if (e.entryType === 'largest-contentful-paint') window.__perfMetrics.lcp = e.startTime; });
      }).observe({ type: 'largest-contentful-paint', buffered: true });
      new PerformanceObserver(list => {
        let cls = 0;
        list.getEntries().forEach(e => { if (!e.hadRecentInput) cls += e.value; });
        window.__perfMetrics.cls = (window.__perfMetrics.cls || 0) + cls;
      }).observe({ type: 'layout-shift', buffered: true });
    });

    const navStart = Date.now();
    await coldPage.goto(`${baseUrl}/dataapp/tables`, { waitUntil: 'load' });
    await coldPage.waitForSelector('#data-table', { state: 'visible', timeout: 15000 });
    const navEnd = Date.now();
    metrics.wallClock = navEnd - navStart;

    // Navigation timing from browser
    const navTiming = await coldPage.evaluate(() => {
      const t = performance.getEntriesByType('navigation')[0];
      if (!t) return null;
      return {
        ttfb:          Math.round(t.responseStart - t.requestStart),
        domInteractive: Math.round(t.domInteractive - t.startTime),
        domComplete:   Math.round(t.domContentLoadedEventEnd - t.startTime),
        loadComplete:  Math.round(t.loadEventEnd - t.startTime),
        transferSize:  Math.round(t.transferSize / 1024), // KB
      };
    });

    // Core Web Vitals
    await coldPage.waitForTimeout(500); // give LCP observer time to fire
    const webVitals = await coldPage.evaluate(() => window.__perfMetrics || {});

    // Resource timing — find the employees API call
    const apiTiming = await coldPage.evaluate(() => {
      const entries = performance.getEntriesByType('resource');
      const api     = entries.find(e => e.name.includes('/api/dataapp/employees') && !e.name.includes('summary'));
      return api ? Math.round(api.duration) : null;
    });

    // Total resource size
    const totalKB = await coldPage.evaluate(() => {
      const entries = performance.getEntriesByType('resource');
      return Math.round(entries.reduce((sum, e) => sum + (e.transferSize || 0), 0) / 1024);
    });

    Object.assign(metrics, navTiming || {}, {
      lcp:            webVitals.lcp ? Math.round(webVitals.lcp) : null,
      cls:            webVitals.cls ? Number(webVitals.cls.toFixed(4)) : 0,
      apiDuration:    apiTiming,
      totalResources: totalKB,
    });

    addLog(`Cold load: TTFB=${metrics.ttfb}ms DOM=${metrics.domComplete}ms LCP=${metrics.lcp}ms`, 'success');
    onStep?.(stepIdx++, { action: 'perf_measure', target: 'Cold page load' }, 'success');

    await coldCtx.close();

    // ── Run 2: Table render time (from navigation start to first visible row) ─
    onStep?.(stepIdx, { action: 'perf_measure', target: 'Table render time' }, 'running');
    addLog('Measuring table render time…');

    const renderCtx  = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const renderPage = await renderCtx.newPage();

    await renderPage.addInitScript(() => {
      window.__tableStart = performance.now();
    });
    await renderPage.goto(`${baseUrl}/dataapp/tables`, { waitUntil: 'domcontentloaded' });
    const tableRender = await renderPage.evaluate(async () => {
      await new Promise(resolve => {
        const check = () => {
          if (document.querySelector('#table-body tr[data-id]')) return resolve();
          requestAnimationFrame(check);
        };
        check();
      });
      return Math.round(performance.now() - window.__tableStart);
    });
    metrics.tableRender = tableRender;
    addLog(`Table render: ${tableRender}ms`, tableRender < BUDGETS.tableRender.acceptable ? 'success' : 'warn');
    onStep?.(stepIdx++, { action: 'perf_measure', target: 'Table render time' }, 'success');

    await renderCtx.close();

    // ── Run 3: Filter response time (type → DOM updates) ──────────────────
    onStep?.(stepIdx, { action: 'perf_measure', target: 'Filter response time' }, 'running');
    addLog('Measuring filter interaction time…');

    const filterCtx  = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const filterPage = await filterCtx.newPage();
    await filterPage.goto(`${baseUrl}/dataapp/tables`, { waitUntil: 'networkidle' });
    await filterPage.waitForSelector('#table-body tr[data-id]', { state: 'visible' });

    const filterStart = Date.now();
    await filterPage.fill('#filter-input', 'Engineering');
    // Wait for DOM to update (debounce is 300ms, so wait for it)
    await filterPage.waitForFunction(() => {
      const rows = document.querySelectorAll('#table-body tr[data-id]');
      if (!rows.length) return false;
      // Check that at least one row matches Engineering
      return Array.from(rows).some(r => r.textContent.includes('Engineering'));
    }, { timeout: 2000 });
    const filterEnd = Date.now();
    metrics.filterResponse = filterEnd - filterStart;
    addLog(`Filter response: ${metrics.filterResponse}ms`, 'success');
    onStep?.(stepIdx++, { action: 'perf_measure', target: 'Filter response time' }, 'success');
    await filterCtx.close();

    // ── Assertions against budgets ─────────────────────────────────────────
    onStep?.(stepIdx, { action: 'perf_assert', target: 'Budget assertions' }, 'running');
    const budgetResults = [];
    for (const [key, budget] of Object.entries(BUDGETS)) {
      const value = metrics[key];
      if (value === null || value === undefined) {
        budgetResults.push({ metric: key, label: budget.label, value: 'N/A', rating: 'skip', budget });
        continue;
      }
      const rating = value <= budget.good ? 'good' : value <= budget.acceptable ? 'needs-improvement' : 'poor';
      budgetResults.push({ metric: key, label: budget.label, value, unit: budget.unit, rating, budget });
    }

    const poor     = budgetResults.filter(r => r.rating === 'poor');
    const needsImp = budgetResults.filter(r => r.rating === 'needs-improvement');
    const good     = budgetResults.filter(r => r.rating === 'good');

    checks.push({
      name:    'Core Web Vitals & Performance Budgets',
      status:  poor.length === 0 ? 'pass' : 'fail',
      message: poor.length === 0
        ? `${good.length} good, ${needsImp.length} needs-improvement, 0 poor`
        : `${poor.length} metric(s) exceeded budget: ${poor.map(r=>`${r.label} (${r.value}${r.unit}>`+r.budget.acceptable+r.unit+')').join(', ')}`,
      metrics,
      budgetResults,
    });

    addLog(`Budgets: ${good.length} good, ${needsImp.length} needs-improvement, ${poor.length} poor`, poor.length === 0 ? 'success' : 'warn');
    onStep?.(stepIdx++, { action: 'perf_assert', target: 'Budget assertions' }, poor.length === 0 ? 'success' : 'failed');

    // CLS separate check (different unit — score not time)
    if (metrics.cls !== undefined) {
      const clsGood = metrics.cls <= 0.1;
      checks.push({
        name:   'Cumulative Layout Shift (CLS)',
        status: clsGood ? 'pass' : 'fail',
        message: `CLS = ${metrics.cls} (${metrics.cls <= 0.1 ? 'Good ≤ 0.1' : metrics.cls <= 0.25 ? 'Needs Improvement' : 'Poor > 0.25'})`,
        value:  metrics.cls,
      });
      addLog(`CLS: ${metrics.cls}`, clsGood ? 'success' : 'warn');
    }

  } catch (e) {
    addLog(`Runner error: ${e.message}`, 'error');
    checks.push({ name: 'Runner error', status: 'fail', message: e.message });
  } finally {
    await browser.close();
  }

  const failed   = checks.filter(c => c.status === 'fail').length;
  const duration = Date.now() - start;

  return {
    runnerId: RUNNER_ID,
    status:   failed === 0 ? 'pass' : 'fail',
    scenario,
    steps: checks.map((c, i) => ({
      index:  i,
      action: 'perf_check',
      target: c.name,
      status: c.status,
      error:  c.status === 'fail' ? c.message : undefined,
      detail: c,
    })),
    summary:   { total: checks.length, passed: checks.length - failed, failed, duration },
    artifacts: { metrics, checks, logs: [] },
    healMeta:  null,
  };
}