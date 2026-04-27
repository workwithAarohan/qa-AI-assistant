/**
 * runner-orchestrator.js
 *
 * Single entry point for all test runners.
 * Runners are isolated but share the same RunResult contract.
 *
 * Usage (from server-v2.js):
 *   import { runScenario, getRunners } from './runners/runner-orchestrator.js';
 *   const result = await runScenario('data', scenario, config);
 *
 * Each runner is independent — adding a new runner means:
 *   1. Create runners/my-runner.js exporting { RUNNER_ID, run() }
 *   2. Import and register it here
 *   3. Done — server and UI pick it up automatically
 */

import * as uiRunner   from './ui-runner.js';
import * as dataRunner from './data-runner.js';
import * as apiRunner  from './api-runner.js';
import * as perfRunner from './perf-runner.js';

// ── Registry ──────────────────────────────────────────────────────────────────
const RUNNERS = {
  [uiRunner.RUNNER_ID]:   uiRunner,
  [dataRunner.RUNNER_ID]: dataRunner,
  [apiRunner.RUNNER_ID]:  apiRunner,
  [perfRunner.RUNNER_ID]: perfRunner,
};

// Runner metadata — displayed in the UI
const RUNNER_META = {
  ui: {
    id:          'ui',
    label:       'UI Tests',
    description: 'Playwright browser automation — clicks, forms, navigation',
    icon:        '🖥',
    color:       '4F46E5',
    tech:        'Playwright',
  },
  data: {
    id:          'data',
    label:       'Data Validation',
    description: 'API intercept + DOM diff — verifies backend data renders correctly',
    icon:        '🔍',
    color:       '059669',
    tech:        'Playwright + fetch',
  },
  api: {
    id:          'api',
    label:       'API Tests',
    description: 'HTTP contract testing — schema, status codes, cross-endpoint consistency',
    icon:        '⚡',
    color:       '0284C7',
    tech:        'fetch (no browser)',
  },
  perf: {
    id:          'perf',
    label:       'Performance',
    description: 'Core Web Vitals, budget assertions, render timing',
    icon:        '📊',
    color:       'D97706',
    tech:        'Playwright + Performance API',
  },
};

// ── Public API ────────────────────────────────────────────────────────────────

export function getRunners() {
  return Object.values(RUNNER_META);
}

export function getRunner(runnerId) {
  return RUNNER_META[runnerId] || null;
}

/**
 * Run a single scenario through the specified runner.
 * Config is passed directly to the runner — each runner takes what it needs.
 */
export async function runScenario(runnerId, scenario, config = {}) {
  const runner = RUNNERS[runnerId];
  if (!runner) {
    return makeErrorResult(runnerId, scenario, `Unknown runner: "${runnerId}". Available: ${Object.keys(RUNNERS).join(', ')}`);
  }

  try {
    const result = await runner.run(scenario, config);
    return normalise(result, runnerId, scenario);
  } catch (err) {
    return makeErrorResult(runnerId, scenario, err.message);
  }
}

/**
 * Run all registered runners against their matching scenarios for an app.
 * Returns a combined report.
 */
export async function runAll(scenarios, config = {}) {
  const results  = [];
  const byRunner = {};

  // Group scenarios by their runner type
  scenarios.forEach(s => {
    const r = s.runner || 'ui';
    (byRunner[r] = byRunner[r] || []).push(s);
  });

  for (const [runnerId, runnerScenarios] of Object.entries(byRunner)) {
    for (const scenario of runnerScenarios) {
      const result = await runScenario(runnerId, scenario, config);
      results.push(result);
    }
  }

  const total   = results.length;
  const passed  = results.filter(r => r.status === 'pass').length;
  const failed  = results.filter(r => r.status === 'fail').length;
  const skipped = results.filter(r => r.status === 'skip').length;

  return {
    type:      'multi-runner',
    status:    failed === 0 ? 'pass' : 'fail',
    results,
    summary:   { total, passed, failed, skipped },
    byRunner:  Object.fromEntries(
      Object.keys(byRunner).map(r => [r, results.filter(x => x.runnerId === r)])
    ),
  };
}

// ── Normalise any runner output to the guaranteed contract ────────────────────
function normalise(result, runnerId, scenario) {
  return {
    runnerId:  result.runnerId || runnerId,
    status:    result.status   || 'skip',
    scenario:  result.scenario || scenario,
    steps:     result.steps    || [],
    summary:   result.summary  || { total: 0, passed: 0, failed: 0, duration: 0 },
    artifacts: result.artifacts || { logs: [] },
    healMeta:  result.healMeta || null,
  };
}

function makeErrorResult(runnerId, scenario, message) {
  return {
    runnerId,
    status:   'fail',
    scenario,
    steps:    [{ index: 0, action: 'init', target: 'runner', status: 'fail', error: message }],
    summary:  { total: 1, passed: 0, failed: 1, duration: 0 },
    artifacts: { logs: [{ text: message, level: 'error' }] },
    healMeta: null,
  };
}