/**
 * failure-classifier.js
 *
 * Classifies WHY a test failed before deciding whether to heal.
 * AUTOMATION failures are healable. FUNCTIONAL/ASSERTION are real bugs.
 */

// Patterns = automation problem (selector changed, timing) → HEALABLE
const AUTOMATION_PATTERNS = [
  // Playwright locator errors
  /locator.*not found/i,
  /no element.*matching/i,
  /element.*not visible/i,
  /waiting for.*selector/i,
  /timeout.*exceeded/i,
  /element.*not attached/i,
  /element.*detached/i,
  /selector.*did not match/i,
  /failed to find/i,
  /target page.*closed/i,
  /strict mode violation/i,
  /element.*intercept.*pointer/i,
  // The exact phrase from screenshot 2:
  /selector not found or not clickable/i,
  /not found or not clickable/i,
  /is not clickable/i,
  /is not attached to the dom/i,
  /element handle.*disposed/i,
  /node is detached/i,
  /cannot find/i,
  /unable to find/i,
  /no node found/i,
];

// Patterns = real bug (element found but wrong state/value/url) → NOT healable
const FUNCTIONAL_PATTERNS = [
  /expected.*to (be|contain|have|equal)/i,
  /text validation failed/i,
  /expected.*but (found|got|received)/i,
  /assertion.*failed/i,
  /value mismatch/i,
  /wrong.*text/i,
  /incorrect.*value/i,
];

const NAVIGATION_PATTERNS = [
  /url.*does not match/i,
  /expected url/i,
  /navigation.*unexpected/i,
  /waiting for url.*to include/i,
];

export const FAILURE_TYPE = {
  AUTOMATION:  'AUTOMATION',
  FUNCTIONAL:  'FUNCTIONAL',
  ASSERTION:   'ASSERTION',
  NAVIGATION:  'NAVIGATION',
  NETWORK:     'NETWORK',
  UNKNOWN:     'UNKNOWN',
};

export const HEAL_DECISION = {
  HEAL:       'HEAL',
  BUG_REPORT: 'BUG_REPORT',
  RETRY:      'RETRY',
  ASK:        'ASK',
};

export function classifyFailure(step, errorMessage, results = []) {
  const err    = errorMessage || '';
  const action = (step?.action || '').toLowerCase();

  // Network errors
  if (/net::err|ERR_CONNECTION|ECONNREFUSED|ENOTFOUND/i.test(err)) {
    return { type: FAILURE_TYPE.NETWORK, decision: HEAL_DECISION.RETRY, confidence: 'high', reason: 'Network or connection error — the app may not be running.' };
  }

  // Navigation assertions — always a real bug
  if (['expecturl', 'verifyurl'].includes(action) || NAVIGATION_PATTERNS.some(p => p.test(err))) {
    return { type: FAILURE_TYPE.NAVIGATION, decision: HEAL_DECISION.BUG_REPORT, confidence: 'high', reason: 'Navigation went to the wrong URL — this is a functional bug, not a selector issue.' };
  }

  // expect/assert/verify steps
  if (['expect', 'assert', 'asserttext', 'verify'].includes(action)) {
    if (AUTOMATION_PATTERNS.some(p => p.test(err))) {
      return { type: FAILURE_TYPE.AUTOMATION, decision: HEAL_DECISION.HEAL, confidence: 'high', reason: 'Expected element was not found in the DOM — likely a selector or timing issue.' };
    }
    return { type: FAILURE_TYPE.ASSERTION, decision: HEAL_DECISION.BUG_REPORT, confidence: 'high', reason: 'Assertion failed — the element exists but its content or state is wrong. This is a real application bug.' };
  }

  // click / type / fill — selector errors are automation problems
  if (['click', 'type', 'fill', 'press'].includes(action)) {
    if (AUTOMATION_PATTERNS.some(p => p.test(err))) {
      return { type: FAILURE_TYPE.AUTOMATION, decision: HEAL_DECISION.HEAL, confidence: 'high', reason: 'Element not found or not interactable — the selector may have changed in the application.' };
    }
    if (FUNCTIONAL_PATTERNS.some(p => p.test(err))) {
      return { type: FAILURE_TYPE.FUNCTIONAL, decision: HEAL_DECISION.BUG_REPORT, confidence: 'medium', reason: 'Interaction failed due to unexpected element state — may be a real bug.' };
    }
  }

  // Generic fallback matching
  if (AUTOMATION_PATTERNS.some(p => p.test(err))) {
    return { type: FAILURE_TYPE.AUTOMATION, decision: HEAL_DECISION.HEAL, confidence: 'medium', reason: 'Element not found or timing issue — auto-heal may resolve this.' };
  }
  if (FUNCTIONAL_PATTERNS.some(p => p.test(err))) {
    return { type: FAILURE_TYPE.FUNCTIONAL, decision: HEAL_DECISION.BUG_REPORT, confidence: 'medium', reason: 'Functional mismatch detected — this looks like a real application bug.' };
  }

  return { type: FAILURE_TYPE.UNKNOWN, decision: HEAL_DECISION.ASK, confidence: 'low', reason: 'Could not determine failure cause. Review manually.' };
}

export const DECISION_META = {
  [HEAL_DECISION.HEAL]:       { label: 'Automation issue — selector may have changed', colour: 'amber', canHeal: true },
  [HEAL_DECISION.BUG_REPORT]: { label: 'Application bug — healing will not fix this',  colour: 'red',   canHeal: false },
  [HEAL_DECISION.RETRY]:      { label: 'Network issue — retry recommended',             colour: 'sky',   canHeal: false },
  [HEAL_DECISION.ASK]:        { label: 'Unknown cause — review required',               colour: 'gray',  canHeal: true },
};