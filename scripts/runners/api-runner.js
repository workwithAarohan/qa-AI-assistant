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
  let employeesCall = null;
  let summaryCall = null;

  const step = (meta) => {
    onStep?.(stepIdx, toStepEvent(meta), 'running');
    return stepIdx++;
  };
  const finish = (i, test) => {
    const status = test.status === 'pass' ? 'success' : 'failed';
    onStep?.(i, toStepEvent(test.meta || { title: test.name }, test), status);
  };

  const scenarioPlan = selectScenarioChecks(scenario);
  addLog(`API scenario matched: ${scenarioPlan.label}`);

  try {
    for (const check of scenarioPlan.checks) {
      await runCheck(check);
    }

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
      method: c.meta?.method,
      endpoint: c.meta?.endpoint,
      expectedStatus: c.meta?.expectedStatus,
      actualStatus: c.meta?.actualStatus,
      duration: c.meta?.duration,
      assertions: c.meta?.assertions,
      checks: c.checks,
      message: c.message,
      request: c.meta?.request,
      response: c.meta?.response,
      detail: c,
    })),
    summary:   { total: checks.length, passed: checks.length - failed, failed, duration },
    artifacts: { checks, logs: [] },
    healMeta:  null,
  };

  async function runCheck(kind) {
    const meta = metaForCheck(kind);
    const idx = step(meta);
    let test;
    try {
      test = await buildCheck(kind, meta);
    } catch (e) {
      test = {
        name: meta.title,
        meta: { ...meta, actualStatus: 'error', response: { error: e.message } },
        checks: [{ label: 'Check completed', pass: false, actual: e.message }],
      };
    }
    const summary = summarise(test);
    checks.push(summary);
    addLog(`${summary.name}: ${summary.status}`, summary.status === 'pass' ? 'success' : 'error');
    finish(idx, summary);
    return summary;
  }

  async function getEmployees() {
    if (!employeesCall) employeesCall = await apiCall('GET', `${baseUrl}/api/dataapp/employees`);
    return employeesCall;
  }

  async function getSummary() {
    if (!summaryCall) summaryCall = await apiCall('GET', `${baseUrl}/api/dataapp/employees/summary`);
    return summaryCall;
  }

  async function buildCheck(kind, meta) {
    if (kind === 'collection') return buildCollectionCheck(meta);
    if (kind === 'schema') return buildSchemaCheck(meta);
    if (kind === 'detail') return buildDetailCheck(meta);
    if (kind === 'missing') return buildMissingCheck(meta);
    if (kind === 'summary') return buildSummaryCheck(meta);
    if (kind === 'consistency') return buildConsistencyCheck(meta);
    if (kind === 'filter_contract') return buildFilterContract(meta);
    if (kind === 'sort_contract') return buildSortContract(meta);
    if (kind === 'pagination_contract') return buildPaginationContract(meta);
    if (kind === 'export_contract') return buildExportContract(meta);
    if (kind === 'valid_submit') return buildValidationCheck(meta, validPayload(), 200, true, []);
    if (kind === 'empty_submit') return buildValidationCheck(meta, {}, 422, false, ['name', 'email', 'department', 'start_date']);
    if (kind === 'invalid_email') return buildValidationCheck(meta, { ...validPayload(), email: 'not-an-email' }, 422, false, ['email']);
    if (kind === 'invalid_phone_format') return buildValidationCheck(meta, { ...validPayload(), phone: '1234567' }, 422, false, ['phone']);
    if (kind === 'past_date') return buildValidationCheck(meta, { ...validPayload(), start_date: '2020-01-01' }, 422, false, ['start_date']);
    return buildCollectionCheck(meta);
  }

  async function buildCollectionCheck(meta) {
    const { data, status, duration } = await getEmployees();
    return {
      name: 'Employee collection contract',
      meta: { ...meta, actualStatus: status, duration, response: previewJson(data) },
      checks: [
        { label: 'Status 200', pass: status === 200, actual: status },
        { label: 'Response is an array', pass: Array.isArray(data), actual: Array.isArray(data) ? 'array' : typeof data },
        { label: 'Table has rows to render', pass: Array.isArray(data) && data.length > 0, actual: data?.length },
        { label: 'Response under 500ms', pass: duration < 500, actual: `${duration}ms` },
      ],
    };
  }

  async function buildSchemaCheck(meta) {
    const { data } = await getEmployees();
    const schemaErrors = [];
    if (Array.isArray(data)) {
      data.forEach((emp, i) => {
        const errs = validateSchema(emp, EMPLOYEE_SCHEMA);
        if (errs.length) schemaErrors.push(`Record ${i + 1} (id:${emp.id}): ${errs.join(', ')}`);
      });
    }
    return {
      name: 'Employee row schema contract',
      meta: { ...meta, actualStatus: schemaErrors.length === 0 ? 'valid' : 'invalid', response: { checkedRecords: data?.length || 0, errors: schemaErrors.slice(0, 10) } },
      checks: [
        { label: `${data?.length || 0} rows match required fields`, pass: schemaErrors.length === 0, actual: schemaErrors.length === 0 ? 'valid' : `${schemaErrors.length} error(s)` },
      ],
      detail: schemaErrors.slice(0, 10),
    };
  }

  async function buildDetailCheck(meta) {
    const { data: allEmployees } = await getEmployees();
    const { data, status, duration } = await apiCall('GET', `${baseUrl}/api/dataapp/employees/1`);
    const matchesArray = allEmployees?.find(e => e.id === 1);
    return {
      name: 'Employee detail contract',
      meta: { ...meta, actualStatus: status, duration, response: data },
      checks: [
        { label: 'Status 200', pass: status === 200, actual: status },
        { label: 'Returns one object', pass: !Array.isArray(data) && typeof data === 'object', actual: typeof data },
        { label: 'ID matches request', pass: data?.id === 1, actual: data?.id },
        { label: 'Matches collection row', pass: JSON.stringify(data) === JSON.stringify(matchesArray), actual: data?.name },
      ],
    };
  }

  async function buildMissingCheck(meta) {
    const { status, data, duration } = await apiCall('GET', `${baseUrl}/api/dataapp/employees/999`);
    return {
      name: 'Missing employee error contract',
      meta: { ...meta, actualStatus: status, duration, response: data },
      checks: [
        { label: 'Status 404', pass: status === 404, actual: status },
        { label: 'Error message returned', pass: !!data?.error, actual: data?.error || 'missing' },
      ],
    };
  }

  async function buildSummaryCheck(meta) {
    const { data: allEmployees } = await getEmployees();
    const { data, status, duration } = await getSummary();
    const expectedActive = Array.isArray(allEmployees) ? allEmployees.filter(e => e.status === 'Active').length : undefined;
    return {
      name: 'Employee summary contract',
      meta: { ...meta, actualStatus: status, duration, response: data },
      checks: [
        { label: 'Status 200', pass: status === 200, actual: status },
        { label: 'Total matches collection', pass: data?.total === allEmployees?.length, actual: data?.total },
        { label: 'Active count is correct', pass: data?.active === expectedActive, actual: data?.active },
        { label: 'Department breakdown exists', pass: !!data?.byDepartment, actual: typeof data?.byDepartment },
      ],
    };
  }

  async function buildConsistencyCheck(meta) {
    const { data: allEmployees } = await getEmployees();
    const { data: summary } = await getSummary();
    const computedSalary = allEmployees?.reduce((sum, e) => sum + e.salary, 0) ?? 0;
    return {
      name: 'Cross-endpoint consistency',
      meta: { ...meta, actualStatus: 'computed', response: { computedSalary, summaryTotals: summary } },
      checks: [
        { label: 'totalSalary matches computed collection', pass: summary?.totalSalary === computedSalary, actual: `summary=${summary?.totalSalary}, computed=${computedSalary}` },
        { label: 'active + inactive equals total', pass: (summary?.active + summary?.inactive) === summary?.total, actual: `${summary?.active}+${summary?.inactive}=${summary?.total}` },
        { label: 'Department counts equal total', pass: summary?.byDepartment && Object.values(summary.byDepartment).reduce((s, v) => s + v, 0) === summary?.total, actual: summary?.byDepartment ? Object.values(summary.byDepartment).reduce((s, v) => s + v, 0) : 'N/A' },
      ],
    };
  }

  async function buildFilterContract(meta) {
    const { data, status, duration } = await getEmployees();
    const rows = Array.isArray(data) ? data : [];
    const searchableFields = ['name', 'email', 'department', 'role'];
    const engineeringRows = rows.filter(e => String(e.department).toLowerCase().includes('engineering'));
    return {
      name: 'Filterable employee data contract',
      meta: { ...meta, actualStatus: status, duration, response: previewJson(engineeringRows) },
      checks: [
        { label: 'Collection is available for client filtering', pass: status === 200 && rows.length > 0, actual: `${status}, ${rows.length} rows` },
        { label: 'Searchable fields are present', pass: rows.every(r => searchableFields.every(f => typeof r[f] === 'string')), actual: searchableFields.join(', ') },
        { label: 'Filter term has matching rows', pass: engineeringRows.length > 0, actual: `${engineeringRows.length} Engineering rows` },
      ],
    };
  }

  async function buildSortContract(meta) {
    const { data, status, duration } = await getEmployees();
    const rows = Array.isArray(data) ? data : [];
    const salaryValues = rows.map(r => r.salary).filter(v => typeof v === 'number');
    const dateValues = rows.map(r => r.start_date).filter(v => /^\d{4}-\d{2}-\d{2}$/.test(String(v)));
    const sortedBySalary = [...rows].sort((a, b) => a.salary - b.salary);
    return {
      name: 'Sortable employee data contract',
      meta: { ...meta, actualStatus: status, duration, response: { firstBySalary: sortedBySalary.slice(0, 3), sortableFields: ['name', 'salary', 'start_date'] } },
      checks: [
        { label: 'Collection is available for sorting', pass: status === 200 && rows.length > 1, actual: `${status}, ${rows.length} rows` },
        { label: 'Salary values are numeric', pass: salaryValues.length === rows.length, actual: `${salaryValues.length}/${rows.length}` },
        { label: 'Start dates are ISO-like strings', pass: dateValues.length === rows.length, actual: `${dateValues.length}/${rows.length}` },
        { label: 'Stable IDs remain attached after sort', pass: sortedBySalary.every(r => typeof r.id === 'number'), actual: sortedBySalary[0]?.id },
      ],
    };
  }

  async function buildPaginationContract(meta) {
    const { data, status, duration } = await getEmployees();
    const rows = Array.isArray(data) ? data : [];
    const pageSize = 10;
    const pageOne = rows.slice(0, pageSize);
    const pageTwo = rows.slice(pageSize, pageSize * 2);
    return {
      name: 'Paginated table data contract',
      meta: { ...meta, actualStatus: status, duration, response: { pageSize, pageOne: previewJson(pageOne), pageTwo: previewJson(pageTwo) } },
      checks: [
        { label: 'Collection is available', pass: status === 200, actual: status },
        { label: 'Dataset has more than one page', pass: rows.length > pageSize, actual: `${rows.length} rows` },
        { label: 'First page has expected size', pass: pageOne.length === pageSize, actual: pageOne.length },
        { label: 'Second page starts after first page', pass: pageOne.at(-1)?.id !== pageTwo[0]?.id, actual: `p1=${pageOne.at(-1)?.id}, p2=${pageTwo[0]?.id}` },
      ],
    };
  }

  async function buildExportContract(meta) {
    const { data, status, duration } = await getEmployees();
    const rows = Array.isArray(data) ? data : [];
    const exportColumns = ['id', 'name', 'email', 'department', 'role', 'salary', 'start_date', 'status'];
    const missing = rows.slice(0, 10).flatMap((row, idx) => exportColumns.filter(col => row[col] === undefined || row[col] === null || row[col] === '').map(col => `row ${idx + 1}: ${col}`));
    return {
      name: 'CSV export data contract',
      meta: { ...meta, actualStatus: status, duration, response: { exportColumns, sample: rows.slice(0, 3), missing: missing.slice(0, 10) } },
      checks: [
        { label: 'Collection is available for export', pass: status === 200 && rows.length > 0, actual: `${status}, ${rows.length} rows` },
        { label: 'Export columns are present', pass: missing.length === 0, actual: missing.length ? missing.slice(0, 3).join('; ') : exportColumns.join(', ') },
        { label: 'Dataset can produce CSV rows', pass: rows.every(r => exportColumns.every(col => Object.prototype.hasOwnProperty.call(r, col))), actual: `${rows.length} rows` },
      ],
      detail: missing.slice(0, 10),
    };
  }

  async function buildValidationCheck(meta, payload, expectedStatus, expectedValid, expectedFields) {
    const { data, status, duration } = await apiCall('POST', `${baseUrl}/api/dataapp/validate`, payload);
    const fields = Array.isArray(data?.errors) ? data.errors.map(e => e.field) : [];
    return {
      name: meta.title,
      meta: { ...meta, actualStatus: status, duration, request: payload, response: data },
      checks: [
        { label: `Status ${expectedStatus}`, pass: status === expectedStatus, actual: status },
        { label: `valid is ${expectedValid}`, pass: data?.valid === expectedValid, actual: data?.valid },
        { label: expectedFields.length ? 'Expected validation fields returned' : 'No validation errors returned', pass: expectedFields.length ? expectedFields.every(f => fields.includes(f)) : Array.isArray(data?.errors) && data.errors.length === 0, actual: fields.join(', ') || 'none' },
      ],
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function selectScenarioChecks(scenario = {}) {
  const id = String(scenario.id || scenario.name || '').toLowerCase();
  const mod = String(scenario.module || '').toLowerCase();

  if (mod.includes('validation')) {
    if (id.includes('empty')) return { label: 'empty submit API validation', checks: ['empty_submit'] };
    if (id.includes('email')) return { label: 'invalid email API validation', checks: ['invalid_email'] };
    if (id.includes('phone')) return { label: 'invalid phone API validation', checks: ['invalid_phone_format'] };
    if (id.includes('past') || id.includes('date')) return { label: 'past date API validation', checks: ['past_date'] };
    if (id.includes('valid')) return { label: 'valid form submit API validation', checks: ['valid_submit'] };
    return { label: 'form validation API smoke', checks: ['valid_submit', 'empty_submit'] };
  }

  if (id.includes('filter')) return { label: 'table filter data contract', checks: ['filter_contract'] };
  if (id.includes('sort')) return { label: 'table sort data contract', checks: ['sort_contract'] };
  if (id.includes('paginat')) return { label: 'table pagination data contract', checks: ['pagination_contract'] };
  if (id.includes('export') || id.includes('csv')) return { label: 'table export data contract', checks: ['export_contract'] };
  if (id.includes('table') || id.includes('load')) return { label: 'table load API contract', checks: ['collection', 'schema'] };

  return {
    label: 'general DataApp API smoke',
    checks: ['collection', 'schema', 'detail', 'missing', 'summary', 'consistency'],
  };
}

function metaForCheck(kind) {
  const meta = {
    collection: { title: 'GET employees collection', method: 'GET', endpoint: '/api/dataapp/employees', expectedStatus: 200 },
    schema: { title: 'Validate employee row schema', method: 'SCHEMA', endpoint: '/api/dataapp/employees[*]', expectedStatus: 'valid' },
    detail: { title: 'GET employee by id', method: 'GET', endpoint: '/api/dataapp/employees/1', expectedStatus: 200 },
    missing: { title: 'GET missing employee', method: 'GET', endpoint: '/api/dataapp/employees/999', expectedStatus: 404 },
    summary: { title: 'GET employee summary', method: 'GET', endpoint: '/api/dataapp/employees/summary', expectedStatus: 200 },
    consistency: { title: 'Cross-endpoint consistency', method: 'CHECK', endpoint: '/api/dataapp/employees + /summary', expectedStatus: 'consistent' },
    filter_contract: { title: 'Verify filterable table data', method: 'GET', endpoint: '/api/dataapp/employees', expectedStatus: 200 },
    sort_contract: { title: 'Verify sortable table data', method: 'GET', endpoint: '/api/dataapp/employees', expectedStatus: 200 },
    pagination_contract: { title: 'Verify paginated table data', method: 'GET', endpoint: '/api/dataapp/employees', expectedStatus: 200 },
    export_contract: { title: 'Verify CSV export data', method: 'GET', endpoint: '/api/dataapp/employees', expectedStatus: 200 },
    valid_submit: { title: 'POST valid validation payload', method: 'POST', endpoint: '/api/dataapp/validate', expectedStatus: 200 },
    empty_submit: { title: 'POST empty validation payload', method: 'POST', endpoint: '/api/dataapp/validate', expectedStatus: 422 },
    invalid_email: { title: 'POST invalid email payload', method: 'POST', endpoint: '/api/dataapp/validate', expectedStatus: 422 },
    invalid_phone_format: { title: 'POST invalid phone payload', method: 'POST', endpoint: '/api/dataapp/validate', expectedStatus: 422 },
    past_date: { title: 'POST past start date payload', method: 'POST', endpoint: '/api/dataapp/validate', expectedStatus: 422 },
  };
  return meta[kind] || meta.collection;
}

function validPayload() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return {
    name: 'Jane Smith',
    email: 'jane@company.com',
    phone: '555-123-4567',
    department: 'Engineering',
    start_date: tomorrow.toISOString().slice(0, 10),
  };
}

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
  const assertionSummary = { total: test.checks.length, passed: test.checks.length - failed.length, failed: failed.length };
  return { name: test.name, status, message, failedChecks: failed.length, totalChecks: test.checks.length, checks: test.checks, detail: test.detail, meta: { ...(test.meta || {}), assertions: assertionSummary } };
}

function toStepEvent(meta = {}, test = null) {
  const assertions = test?.meta?.assertions || meta.assertions || null;
  return {
    action: 'api_test',
    target: meta.title || meta.endpoint || test?.name || 'API check',
    title: meta.title || test?.name || 'API check',
    method: meta.method || 'CHECK',
    endpoint: meta.endpoint || '',
    expectedStatus: meta.expectedStatus,
    actualStatus: meta.actualStatus,
    duration: meta.duration,
    assertions,
    checks: test?.checks || meta.checks || [],
    message: test?.message || meta.message || '',
    request: meta.request,
    response: meta.response,
  };
}

function previewJson(value) {
  if (Array.isArray(value)) return { type: 'array', length: value.length, sample: value.slice(0, 5) };
  return value;
}
