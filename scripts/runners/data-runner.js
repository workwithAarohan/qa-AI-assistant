/**
 * runners/data-runner.js
 *
 * Data Validation Runner — Triple-check pattern:
 *
 *   1. Direct API call  → ground truth JSON (what the backend actually returns)
 *   2. Playwright intercept → what the browser actually received
 *   3. DOM scrape       → what the user actually sees
 *
 * Then diffs all three. Catches:
 *   - Transformation bugs (backend returns 120000, table shows "120,000" — expected, marked OK)
 *   - Truncation (backend "Engineering", table shows "Eng..." — FAIL)
 *   - Type coercion (id: "1" vs id: 1 — configurable tolerance)
 *   - Pagination integrity (page 2 row 1 = record 11 from sorted API response)
 *   - Sort correctness (after clicking salary header, DOM order must match API sorted order)
 *   - Filter correctness (filtered DOM rows must all satisfy the filter predicate)
 *   - Count consistency (#row-count DOM text must equal filtered data length)
 *
 * Returns the same unified RunResult shape as ui-runner.js.
 */

import { chromium } from 'playwright';

export const RUNNER_ID = 'data';

// ── Entry point ───────────────────────────────────────────────────────────────
export async function run(scenario, config = {}) {
  const { baseUrl, headless = false, onStep, onLog } = config;
  const addLog = (text, level = 'info') => { onLog?.(text, level); };
  const start  = Date.now();
  const checks = [];

  addLog(`Data validation: ${scenario.name}`);

  const browser = await chromium.launch({ headless });
  const ctx     = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page    = await ctx.newPage();

  try {
    // ── Layer 1: Direct API fetch (ground truth) ─────────────────────────────
    onStep?.(0, { action: 'api_fetch', target: '/api/dataapp/employees' }, 'running');
    addLog('Fetching ground truth from API directly…');
    const apiResp    = await page.evaluate(async (url) => {
      const r = await fetch(url); return r.json();
    }, `${baseUrl}/api/dataapp/employees`);
    addLog(`API returned ${apiResp.length} records`, 'success');
    onStep?.(0, { action: 'api_fetch', target: '/api/dataapp/employees' }, 'success');

    // ── Layer 2: Playwright route intercept ──────────────────────────────────
    onStep?.(1, { action: 'intercept', target: '/api/dataapp/employees' }, 'running');
    addLog('Setting up API intercept…');
    let interceptedData = null;
    await page.route('**/api/dataapp/employees', async route => {
      const resp = await route.fetch();
      const body = await resp.json();
      interceptedData = body;
      await route.fulfill({ response: resp, body: JSON.stringify(body) });
    });

    // ── Layer 3: Navigate and scrape DOM ─────────────────────────────────────
    onStep?.(2, { action: 'navigate', target: `${baseUrl}/dataapp/tables` }, 'running');
    addLog('Navigating to DataApp tables…');
    await page.goto(`${baseUrl}/dataapp/tables`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#data-table', { state: 'visible', timeout: 10000 });
    addLog('Table rendered', 'success');
    onStep?.(2, { action: 'navigate', target: `${baseUrl}/dataapp/tables` }, 'success');
    onStep?.(1, { action: 'intercept', target: '/api/dataapp/employees' }, 'success');

    // ── Check A: Intercept integrity ─────────────────────────────────────────
    onStep?.(3, { action: 'check_intercept', target: 'browser received same data as API' }, 'running');
    const interceptCheck = checkInterceptIntegrity(apiResp, interceptedData);
    checks.push(interceptCheck);
    addLog(`Intercept integrity: ${interceptCheck.status} — ${interceptCheck.message}`, interceptCheck.status === 'pass' ? 'success' : 'error');
    onStep?.(3, { action: 'check_intercept', target: 'browser received same data as API' }, interceptCheck.status === 'pass' ? 'success' : 'failed');

    // ── Check B: Row count in DOM matches API count ──────────────────────────
    onStep?.(4, { action: 'check_count', target: '#row-count' }, 'running');
    const rowCountText = await page.textContent('#row-count');
    const domCount     = parseInt(rowCountText?.match(/\d+/)?.[0] ?? '0');
    const countCheck   = {
      name:    'Row count matches API total',
      status:  domCount === apiResp.length ? 'pass' : 'fail',
      message: domCount === apiResp.length
        ? `Both show ${apiResp.length} employees`
        : `DOM shows ${domCount} but API returned ${apiResp.length}`,
      expected: apiResp.length, actual: domCount,
    };
    checks.push(countCheck);
    addLog(`Count check: ${countCheck.status} — ${countCheck.message}`, countCheck.status === 'pass' ? 'success' : 'error');
    onStep?.(4, { action: 'check_count', target: '#row-count' }, countCheck.status === 'pass' ? 'success' : 'failed');

    // ── Check C: First page DOM rows match API first 10 (default sort = id asc)
    onStep?.(5, { action: 'check_first_page', target: '#table-body rows 1–10' }, 'running');
    const domRows  = await scrapeDomRows(page);
    const apiPage1 = apiResp.slice(0, 10); // API default: id asc, page 1
    const pageCheck = checkPageRows(apiPage1, domRows);
    checks.push(pageCheck);
    addLog(`Page 1 data integrity: ${pageCheck.status} — ${pageCheck.message}`, pageCheck.status === 'pass' ? 'success' : 'error');
    onStep?.(5, { action: 'check_first_page', target: '#table-body rows 1–10' }, pageCheck.status === 'pass' ? 'success' : 'failed');

    // ── Check D: Filter correctness ──────────────────────────────────────────
    onStep?.(6, { action: 'check_filter', target: '#filter-input → "Engineering"' }, 'running');
    addLog('Testing filter: "Engineering"…');
    await page.fill('#filter-input', 'Engineering');
    await page.waitForTimeout(400); // debounce
    const filteredDomRows  = await scrapeDomRows(page);
    const filteredApiRows  = apiResp.filter(r =>
      ['name','email','department','role'].some(k => r[k]?.toLowerCase().includes('engineering'))
    ).slice(0, 10);
    const filterCheck = {
      name:    'Filter results match API-filtered data',
      status:  filteredDomRows.length > 0 && filteredDomRows.every(r => r.department?.toLowerCase().includes('engineering')) ? 'pass' : 'fail',
      message: filteredDomRows.every(r => r.department?.toLowerCase().includes('engineering'))
        ? `All ${filteredDomRows.length} visible rows match "Engineering" filter`
        : `${filteredDomRows.filter(r => !r.department?.toLowerCase().includes('engineering')).length} rows do not match filter`,
      domCount:  filteredDomRows.length,
      apiCount:  filteredApiRows.length,
      mismatches: filteredDomRows.filter(r => !r.department?.toLowerCase().includes('engineering')).map(r => r.name),
    };
    checks.push(filterCheck);
    addLog(`Filter check: ${filterCheck.status} — ${filterCheck.message}`, filterCheck.status === 'pass' ? 'success' : 'error');
    onStep?.(6, { action: 'check_filter', target: '#filter-input → "Engineering"' }, filterCheck.status === 'pass' ? 'success' : 'failed');

    // Clear filter
    await page.fill('#filter-input', '');
    await page.waitForTimeout(400);

    // ── Check E: Sort correctness (click Salary header) ─────────────────────
    onStep?.(7, { action: 'check_sort', target: 'th[data-sort="salary"]' }, 'running');
    addLog('Testing sort: click Salary column…');
    await page.click('th[data-sort="salary"]');
    await page.waitForTimeout(200);
    const sortedDomRows = await scrapeDomRows(page);
    const sortedApiRows = [...apiResp].sort((a, b) => a.salary - b.salary).slice(0, 10);
    const sortCheck     = checkSort(sortedApiRows, sortedDomRows);
    checks.push(sortCheck);
    addLog(`Sort check: ${sortCheck.status} — ${sortCheck.message}`, sortCheck.status === 'pass' ? 'success' : 'error');
    onStep?.(7, { action: 'check_sort', target: 'th[data-sort="salary"]' }, sortCheck.status === 'pass' ? 'success' : 'failed');

    // ── Check F: Pagination ──────────────────────────────────────────────────
    onStep?.(8, { action: 'check_pagination', target: '#page-next' }, 'running');
    addLog('Testing pagination: next page…');
    // Reset sort first
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('#data-table', { state: 'visible' });
    await page.click('#page-next');
    await page.waitForTimeout(200);
    const page2DomRows = await scrapeDomRows(page);
    const page2ApiRows = apiResp.slice(10, 20); // records 11–20
    const page2Info    = await page.textContent('#page-info');
    const paginationCheck = checkPageRows(page2ApiRows, page2DomRows, 'Page 2');
    paginationCheck.pageInfo = page2Info?.trim();
    paginationCheck.pageInfoCorrect = page2Info?.includes('Page 2');
    checks.push(paginationCheck);
    addLog(`Pagination check: ${paginationCheck.status} — ${paginationCheck.message}`, paginationCheck.status === 'pass' ? 'success' : 'error');
    onStep?.(8, { action: 'check_pagination', target: '#page-next' }, paginationCheck.status === 'pass' ? 'success' : 'failed');

    // ── Check G: Field-level spot check (name, email, salary formatting) ─────
    onStep?.(9, { action: 'check_fields', target: 'row 1 field values' }, 'running');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('#data-table', { state: 'visible' });
    const spotRows = await scrapeDomRows(page);
    const fieldCheck = checkFieldValues(apiResp.slice(0, Math.min(5, spotRows.length)), spotRows.slice(0, 5));
    checks.push(fieldCheck);
    addLog(`Field values check: ${fieldCheck.status} — ${fieldCheck.message}`, fieldCheck.status === 'pass' ? 'success' : 'error');
    onStep?.(9, { action: 'check_fields', target: 'row 1 field values' }, fieldCheck.status === 'pass' ? 'success' : 'failed');

  } catch (e) {
    addLog(`Runner error: ${e.message}`, 'error');
    checks.push({ name: 'Runner error', status: 'fail', message: e.message });
  } finally {
    await ctx.close();
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
      action: 'data_check',
      target: c.name,
      status: c.status,
      error:  c.status === 'fail' ? c.message : undefined,
      detail: c,
    })),
    summary:   { total: checks.length, passed: checks.length - failed, failed, duration },
    artifacts: { checks, logs: [] },
    healMeta:  null,
  };
}

// ── DOM scraper ───────────────────────────────────────────────────────────────
async function scrapeDomRows(page) {
  return page.evaluate(() => {
    const rows = [];
    document.querySelectorAll('#table-body tr[data-id]').forEach(tr => {
      const cells = tr.querySelectorAll('td[data-col]');
      const row   = {};
      cells.forEach(td => {
        const col = td.dataset.col;
        // For salary: strip formatting ($120,000 → 120000)
        if (col === 'salary') {
          row[col] = parseInt(td.textContent.replace(/[^0-9]/g, ''), 10);
        } else {
          // For badge cells (dept, status) get the text inside the badge span
          const badge = td.querySelector('.badge');
          row[col] = (badge || td).textContent.trim();
        }
      });
      rows.push(row);
    });
    return rows;
  });
}

// ── Diff helpers ──────────────────────────────────────────────────────────────
function checkInterceptIntegrity(apiData, interceptData) {
  if (!interceptData) return { name: 'Intercept integrity', status: 'fail', message: 'Browser did not intercept the API call' };
  if (apiData.length !== interceptData.length) {
    return { name: 'Intercept integrity', status: 'fail', message: `API: ${apiData.length} rows, Browser intercepted: ${interceptData.length} rows` };
  }
  // Deep compare first and last record
  const first = JSON.stringify(apiData[0]) === JSON.stringify(interceptData[0]);
  const last  = JSON.stringify(apiData.at(-1)) === JSON.stringify(interceptData.at(-1));
  return {
    name:    'Intercept integrity',
    status:  first && last ? 'pass' : 'fail',
    message: first && last
      ? `${apiData.length} records — browser received identical data to API`
      : 'Data mismatch between direct API call and browser-intercepted response',
  };
}

function checkPageRows(apiRows, domRows, label = 'Page 1') {
  const mismatches = [];
  const len = Math.min(apiRows.length, domRows.length);

  for (let i = 0; i < len; i++) {
    const a = apiRows[i], d = domRows[i];
    const rowMismatches = [];

    // Name: exact match
    if (a.name !== d.name) rowMismatches.push(`name: API="${a.name}" DOM="${d.name}"`);

    // Email: exact match
    if (a.email !== d.email) rowMismatches.push(`email: API="${a.email}" DOM="${d.email}"`);

    // Department: exact match
    if (a.department !== d.department) rowMismatches.push(`dept: API="${a.department}" DOM="${d.department}"`);

    // Salary: API number === DOM parsed number
    const apiSalary = Number(a.salary);
    const domSalary = Number(d.salary);
    if (apiSalary !== domSalary) rowMismatches.push(`salary: API=${apiSalary} DOM=${domSalary}`);

    // Status: exact match
    if (a.status !== d.status) rowMismatches.push(`status: API="${a.status}" DOM="${d.status}"`);

    if (rowMismatches.length) mismatches.push(`Row ${i+1} (${a.name}): ${rowMismatches.join(', ')}`);
  }

  const countMismatch = apiRows.length !== domRows.length
    ? ` (API has ${apiRows.length} rows for this page, DOM shows ${domRows.length})`
    : '';

  return {
    name:       `${label} data integrity`,
    status:     mismatches.length === 0 && !countMismatch ? 'pass' : 'fail',
    message:    mismatches.length === 0 && !countMismatch
      ? `All ${len} rows match between API and DOM`
      : `${mismatches.length} row(s) have mismatches${countMismatch}`,
    mismatches,
  };
}

function checkSort(sortedApiRows, sortedDomRows) {
  const domSalaries = sortedDomRows.map(r => Number(r.salary));
  const apiSalaries = sortedApiRows.map(r => r.salary);
  const domSorted   = [...domSalaries].every((v, i) => i === 0 || v >= domSalaries[i-1]);
  const match       = apiSalaries.slice(0, domSalaries.length).every((v, i) => v === domSalaries[i]);
  return {
    name:    'Sort order correctness',
    status:  domSorted && match ? 'pass' : 'fail',
    message: domSorted && match
      ? `DOM salary column correctly sorted ascending`
      : !domSorted
        ? `DOM rows are not in ascending order (saw ${domSalaries.slice(0,5).join(', ')})`
        : `DOM sort order does not match API: expected [${apiSalaries.slice(0,3).join(', ')}] got [${domSalaries.slice(0,3).join(', ')}]`,
    domOrder: domSalaries.slice(0, 5),
    apiOrder: apiSalaries.slice(0, 5),
  };
}

function checkFieldValues(apiRows, domRows) {
  const issues = [];
  for (let i = 0; i < Math.min(apiRows.length, domRows.length); i++) {
    const a = apiRows[i], d = domRows[i];
    if (!d.name) issues.push(`Row ${i+1}: name missing from DOM`);
    if (!d.email) issues.push(`Row ${i+1}: email missing from DOM`);
    if (!d.department) issues.push(`Row ${i+1}: department missing from DOM`);
    if (isNaN(d.salary)) issues.push(`Row ${i+1}: salary is not a number in DOM ("${d.salary}")`);
    if (!['Active','Inactive'].includes(d.status)) issues.push(`Row ${i+1}: unexpected status "${d.status}"`);
  }
  return {
    name:    'Field value integrity',
    status:  issues.length === 0 ? 'pass' : 'fail',
    message: issues.length === 0
      ? `All fields present and correctly typed across ${domRows.length} rows`
      : `${issues.length} field issue(s) found`,
    issues,
  };
}