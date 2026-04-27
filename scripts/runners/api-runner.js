/**
 * runners/api-runner.js
 *
 * API Test Runner — pure HTTP, no browser.
 * Tests the REST API contract, schema, edge cases, and error handling.
 *
 * Capabilities:
 *   - Schema validation (field types, presence, format)
 *   - Contract testing (status codes, headers, response shape)
 *   - Edge case testing (invalid IDs, malformed payloads, boundary values)
 *   - Response time assertion
 *   - Cross-endpoint consistency (GET /employees/:id matches GET /employees array)
 */

export const RUNNER_ID = 'api';

const EMPLOYEE_SCHEMA = {
  id:         { type: 'number',  required: true },
  name:       { type: 'string',  required: true, minLen: 3 },
  email:      { type: 'string',  required: true, format: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
  department: { type: 'string',  required: true, enum: ['Engineering','QA','Product','Design'] },
  role:       { type: 'string',  required: true },
  salary:     { type: 'number',  required: true, min: 0 },
  start_date: { type: 'string',  required: true, format: /^\d{4}-\d{2}-\d{2}$/ },
  status:     { type: 'string',  required: true, enum: ['Active','Inactive'] },
};

// ── Entry point ───────────────────────────────────────────────────────────────
export async function run(scenario, config = {}) {
  const { baseUrl, onStep, onLog } = config;
  const addLog = (text, level = 'info') => { onLog?.(text, level); };
  const start  = Date.now();
  const checks = [];
  let stepIdx  = 0;

  const step = (name) => {
    onStep?.(stepIdx, { action: 'api_test', target: name }, 'running');
    return stepIdx++;
  };
  const pass = (i, name) => { onStep?.(i, { action: 'api_test', target: name }, 'success'); };
  const fail = (i, name) => { onStep?.(i, { action: 'api_test', target: name }, 'failed'); };

  addLog(`API validation: ${scenario.name}`);

  try {
    // ── Test 1: GET /employees — 200, array, correct length ────────────────
    const t1 = step('GET /api/dataapp/employees → 200 + array of 50');
    const { data: allEmployees, status: s1, duration: d1 } = await apiCall('GET', `${baseUrl}/api/dataapp/employees`);
    const test1 = {
      name: 'GET /employees returns 200 with full dataset',
      checks: [
        { label: 'Status 200',              pass: s1 === 200,                      actual: s1 },
        { label: 'Response is array',        pass: Array.isArray(allEmployees),     actual: typeof allEmployees },
        { label: '50 records returned',     pass: allEmployees?.length === 50,      actual: allEmployees?.length },
        { label: 'Response < 500ms',        pass: d1 < 500,                        actual: `${d1}ms` },
      ],
    };
    checks.push(summarise(test1));
    addLog(`GET /employees: ${checks.at(-1).status} (${d1}ms, ${allEmployees?.length} records)`, checks.at(-1).status === 'pass' ? 'success' : 'error');
    checks.at(-1).status === 'pass' ? pass(t1, 'GET /employees') : fail(t1, 'GET /employees');

    // ── Test 2: Schema validation — check all 50 records ──────────────────
    const t2 = step('Schema validation — all 50 employee records');
    const schemaErrors = [];
    if (Array.isArray(allEmployees)) {
      allEmployees.forEach((emp, i) => {
        const errs = validateSchema(emp, EMPLOYEE_SCHEMA);
        if (errs.length) schemaErrors.push(`Record ${i+1} (id:${emp.id}): ${errs.join(', ')}`);
      });
    }
    const test2 = {
      name: 'Schema validation — all records',
      checks: [
        { label: `${allEmployees?.length || 0} records all match schema`, pass: schemaErrors.length === 0, actual: schemaErrors.length === 0 ? 'valid' : `${schemaErrors.length} error(s)` },
      ],
      detail: schemaErrors.slice(0, 10),
    };
    checks.push(summarise(test2));
    addLog(`Schema: ${schemaErrors.length === 0 ? 'all valid' : schemaErrors.length + ' error(s)'}`, schemaErrors.length === 0 ? 'success' : 'error');
    checks.at(-1).status === 'pass' ? pass(t2, 'Schema') : fail(t2, 'Schema');

    // ── Test 3: GET /employees/:id — valid ID ──────────────────────────────
    const t3 = step('GET /api/dataapp/employees/1 → single record');
    const { data: emp1, status: s3, duration: d3 } = await apiCall('GET', `${baseUrl}/api/dataapp/employees/1`);
    const matchesArray = allEmployees?.find(e => e.id === 1);
    const test3 = {
      name: 'GET /employees/:id returns correct record',
      checks: [
        { label: 'Status 200',              pass: s3 === 200,                          actual: s3 },
        { label: 'Returns object not array', pass: !Array.isArray(emp1) && typeof emp1 === 'object', actual: typeof emp1 },
        { label: 'ID matches requested',    pass: emp1?.id === 1,                       actual: emp1?.id },
        { label: 'Matches /employees array', pass: JSON.stringify(emp1) === JSON.stringify(matchesArray), actual: emp1?.name },
        { label: 'Response < 300ms',        pass: d3 < 300,                            actual: `${d3}ms` },
      ],
    };
    checks.push(summarise(test3));
    addLog(`GET /employees/1: ${checks.at(-1).status}`, checks.at(-1).status === 'pass' ? 'success' : 'error');
    checks.at(-1).status === 'pass' ? pass(t3, 'GET /employees/:id') : fail(t3, 'GET /employees/:id');

    // ── Test 4: GET /employees/999 — 404 ──────────────────────────────────
    const t4 = step('GET /api/dataapp/employees/999 → 404');
    const { status: s4, data: d4err } = await apiCall('GET', `${baseUrl}/api/dataapp/employees/999`);
    const test4 = {
      name: 'GET /employees/invalid-id returns 404',
      checks: [
        { label: 'Status 404',              pass: s4 === 404,               actual: s4 },
        { label: 'Error message in body',   pass: !!d4err?.error,           actual: d4err?.error || 'missing' },
      ],
    };
    checks.push(summarise(test4));
    addLog(`404 handling: ${checks.at(-1).status}`, checks.at(-1).status === 'pass' ? 'success' : 'error');
    checks.at(-1).status === 'pass' ? pass(t4, '404 handling') : fail(t4, '404 handling');

    // ── Test 5: GET /employees/summary ─────────────────────────────────────
    const t5 = step('GET /api/dataapp/employees/summary → aggregates');
    const { data: summary, status: s5 } = await apiCall('GET', `${baseUrl}/api/dataapp/employees/summary`);
    const expectedTotal = allEmployees?.length || 50;
    const expectedActive = allEmployees?.filter(e => e.status === 'Active').length;
    const test5 = {
      name: 'GET /employees/summary returns correct aggregates',
      checks: [
        { label: 'Status 200',              pass: s5 === 200,                         actual: s5 },
        { label: 'total matches /employees', pass: summary?.total === expectedTotal,    actual: summary?.total },
        { label: 'active count correct',    pass: summary?.active === expectedActive,   actual: summary?.active },
        { label: 'totalSalary is number',   pass: typeof summary?.totalSalary === 'number', actual: typeof summary?.totalSalary },
        { label: 'avgSalary is reasonable', pass: summary?.avgSalary > 50000 && summary?.avgSalary < 300000, actual: summary?.avgSalary },
        { label: 'byDepartment present',    pass: !!summary?.byDepartment,             actual: typeof summary?.byDepartment },
      ],
    };
    checks.push(summarise(test5));
    addLog(`Summary: ${checks.at(-1).status}`, checks.at(-1).status === 'pass' ? 'success' : 'error');
    checks.at(-1).status === 'pass' ? pass(t5, 'GET /summary') : fail(t5, 'GET /summary');

    // ── Test 6: POST /validate — valid payload ─────────────────────────────
    const t6 = step('POST /api/dataapp/validate → valid payload → 200');
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    const validPayload = { name: 'Jane Smith', email: 'jane@company.com', phone: '555-123-4567', department: 'Engineering', start_date: tomorrow.toISOString().slice(0, 10) };
    const { data: v1, status: sv1 } = await apiCall('POST', `${baseUrl}/api/dataapp/validate`, validPayload);
    const test6 = {
      name: 'POST /validate accepts valid payload',
      checks: [
        { label: 'Status 200',           pass: sv1 === 200,   actual: sv1 },
        { label: 'valid: true',          pass: v1?.valid === true,  actual: v1?.valid },
        { label: 'errors array empty',   pass: Array.isArray(v1?.errors) && v1.errors.length === 0, actual: v1?.errors?.length },
      ],
    };
    checks.push(summarise(test6));
    addLog(`POST /validate (valid): ${checks.at(-1).status}`, checks.at(-1).status === 'pass' ? 'success' : 'error');
    checks.at(-1).status === 'pass' ? pass(t6, 'POST /validate valid') : fail(t6, 'POST /validate valid');

    // ── Test 7: POST /validate — invalid payload ───────────────────────────
    const t7 = step('POST /api/dataapp/validate → invalid payload → 422 + errors');
    const badPayload = { name: 'Jo', email: 'not-an-email', phone: '1234567', department: 'Marketing', start_date: '2020-01-01' };
    const { data: v2, status: sv2 } = await apiCall('POST', `${baseUrl}/api/dataapp/validate`, badPayload);
    const test7 = {
      name: 'POST /validate rejects invalid payload with 422',
      checks: [
        { label: 'Status 422',           pass: sv2 === 422,                    actual: sv2 },
        { label: 'valid: false',         pass: v2?.valid === false,            actual: v2?.valid },
        { label: 'errors array present', pass: Array.isArray(v2?.errors) && v2.errors.length > 0, actual: v2?.errors?.length },
        { label: 'name error reported',  pass: v2?.errors?.some(e => e.field === 'name'),  actual: v2?.errors?.map(e=>e.field).join(',') },
        { label: 'email error reported', pass: v2?.errors?.some(e => e.field === 'email'), actual: '' },
        { label: 'dept error reported',  pass: v2?.errors?.some(e => e.field === 'department'), actual: '' },
      ],
    };
    checks.push(summarise(test7));
    addLog(`POST /validate (invalid): ${checks.at(-1).status}`, checks.at(-1).status === 'pass' ? 'success' : 'error');
    checks.at(-1).status === 'pass' ? pass(t7, 'POST /validate invalid') : fail(t7, 'POST /validate invalid');

    // ── Test 8: Data consistency — /employees vs /summary ─────────────────
    const t8 = step('Cross-endpoint: /employees vs /summary consistency');
    const computedSalary = allEmployees?.reduce((sum, e) => sum + e.salary, 0) ?? 0;
    const test8 = {
      name: 'Cross-endpoint data consistency',
      checks: [
        { label: 'totalSalary matches computed', pass: summary?.totalSalary === computedSalary, actual: `summary=${summary?.totalSalary}, computed=${computedSalary}` },
        { label: 'active + inactive = total',    pass: (summary?.active + summary?.inactive) === summary?.total, actual: `${summary?.active}+${summary?.inactive}=${summary?.total}` },
        { label: 'dept counts sum = total',      pass: summary?.byDepartment && Object.values(summary.byDepartment).reduce((s,v)=>s+v,0) === summary?.total, actual: summary?.byDepartment ? Object.values(summary.byDepartment).reduce((s,v)=>s+v,0) : 'N/A' },
      ],
    };
    checks.push(summarise(test8));
    addLog(`Consistency: ${checks.at(-1).status}`, checks.at(-1).status === 'pass' ? 'success' : 'error');
    checks.at(-1).status === 'pass' ? pass(t8, 'Consistency') : fail(t8, 'Consistency');

  } catch (e) {
    addLog(`Runner error: ${e.message}`, 'error');
    checks.push({ name: 'Runner error', status: 'fail', message: e.message, failedChecks: 1, totalChecks: 1 });
  }

  const failed   = checks.filter(c => c.status === 'fail').length;
  const duration = Date.now() - start;

  return {
    runnerId: RUNNER_ID,
    status:   failed === 0 ? 'pass' : 'fail',
    scenario,
    steps: checks.map((c, i) => ({
      index:  i,
      action: 'api_check',
      target: c.name,
      status: c.status,
      error:  c.status === 'fail' ? `${c.failedChecks} assertion(s) failed` : undefined,
      detail: c,
    })),
    summary:   { total: checks.length, passed: checks.length - failed, failed, duration },
    artifacts: { checks, logs: [] },
    healMeta:  null,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function apiCall(method, url, body = null) {
  const start = Date.now();
  const opts  = {
    method,
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);

  try {
    const res      = await fetch(url, opts);
    const duration = Date.now() - start;
    let data;
    try { data = await res.json(); } catch { data = null; }
    return { status: res.status, data, duration, ok: res.ok };
  } catch (e) {
    return { status: 0, data: null, duration: Date.now() - start, ok: false, error: e.message };
  }
}

function validateSchema(obj, schema) {
  const errors = [];
  for (const [key, rule] of Object.entries(schema)) {
    const val = obj[key];
    if (rule.required && (val === undefined || val === null || val === '')) {
      errors.push(`${key}: missing`); continue;
    }
    if (val === undefined || val === null) continue;
    if (rule.type === 'number' && typeof val !== 'number') errors.push(`${key}: expected number, got ${typeof val}`);
    if (rule.type === 'string' && typeof val !== 'string') errors.push(`${key}: expected string, got ${typeof val}`);
    if (rule.minLen && typeof val === 'string' && val.length < rule.minLen) errors.push(`${key}: too short (${val.length} < ${rule.minLen})`);
    if (rule.min !== undefined && typeof val === 'number' && val < rule.min) errors.push(`${key}: ${val} < min ${rule.min}`);
    if (rule.format && typeof val === 'string' && !rule.format.test(val)) errors.push(`${key}: format invalid ("${val}")`);
    if (rule.enum && !rule.enum.includes(val)) errors.push(`${key}: "${val}" not in [${rule.enum.join(', ')}]`);
  }
  return errors;
}

function summarise(test) {
  const failed     = test.checks.filter(c => !c.pass);
  const status     = failed.length === 0 ? 'pass' : 'fail';
  const message    = failed.length === 0
    ? `All ${test.checks.length} assertions passed`
    : failed.map(c => `${c.label}: got ${c.actual}`).join('; ');
  return { name: test.name, status, message, failedChecks: failed.length, totalChecks: test.checks.length, checks: test.checks, detail: test.detail };
}