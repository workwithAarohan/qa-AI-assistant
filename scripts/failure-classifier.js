/**
 * failure-classifier.js
 *
 * Classifies WHY a test step failed before deciding whether to heal.
 *
 * Types:
 *  AUTOMATION  — selector/timing issue, element not found → HEALABLE
 *  FUNCTIONAL  — element exists but wrong value/text/state → REAL BUG
 *  ASSERTION   — business logic assertion failed → REAL BUG
 *  NAVIGATION  — wrong URL after action → REAL BUG
 *  NETWORK     — timeout, fetch failed → MAYBE HEALABLE (retry)
 *  UNKNOWN     — anything else → ASK USER
 */

// Patterns that indicate an automation/selector problem (healable)
const AUTOMATION_PATTERNS = [
  /locator.*not found/i,
  /no element.*matching/i,
  /element.*not visible/i,
  /waiting for.*selector/i,
  /timeout.*exceeded/i,
  /element is not attached/i,
  /element.*detached/i,
  /selector.*did not match/i,
  /failed to find/i,
  /target page.*closed/i,
  /strict mode violation/i,       // multiple elements matched
  /element.*intercept.*pointer/i, // overlapping elements
];

// Patterns that indicate a real functional/logic bug (NOT healable)
const FUNCTIONAL_PATTERNS = [
  /expected.*to (be|contain|have|equal)/i,
  /text validation failed/i,
  /expected.*but (found|got|received)/i,
  /assertion.*failed/i,
  /value mismatch/i,
  /url.*does not match/i,
  /expected url/i,
  /navigation.*unexpected/i,
  /wrong.*text/i,
  /incorrect.*value/i,
];

export const FAILURE_TYPE = {
  AUTOMATION:  'AUTOMATION',   // Healable — selector/DOM issue
  FUNCTIONAL:  'FUNCTIONAL',   // Bug — element exists, wrong behaviour
  ASSERTION:   'ASSERTION',    // Bug — value/text/url assertion failed
  NETWORK:     'NETWORK',      // Retry candidate — timeout/network
  UNKNOWN:     'UNKNOWN',      // Ask user
};

export const HEAL_DECISION = {
  HEAL:        'HEAL',         // Offer auto-heal
  BUG_REPORT:  'BUG_REPORT',  // Flag as real bug, do not heal
  RETRY:       'RETRY',        // Simple retry first, then heal
  ASK:         'ASK',          // Ambiguous — let user decide
};

/**
 * Classify a failure and decide whether healing makes sense.
 *
 * @param {object} step - The step that failed { action, selector, value }
 * @param {string} errorMessage - Raw error from Playwright
 * @param {object[]} results - All step results so far
 * @returns {{ type, decision, confidence, reason }}
 */
export function classifyFailure(step, errorMessage, results = []) {
  const err = errorMessage || '';
  const action = (step?.action || '').toLowerCase();

  // ── Network / timeout (could be flaky, offer retry first) ─────────────────
  if (/net::err|ERR_CONNECTION|ECONNREFUSED|ENOTFOUND/i.test(err)) {
    return {
      type: FAILURE_TYPE.NETWORK,
      decision: HEAL_DECISION.RETRY,
      confidence: 'high',
      reason: 'Network or connection error — the app may not be running.',
    };
  }

  // ── Assertion/verification steps — always a real bug if element found ──────
  if (['expect', 'assert', 'asserttext', 'verify'].includes(action)) {
    // If error is timeout-like, the element just wasn't there (automation)
    if (AUTOMATION_PATTERNS.some(p => p.test(err))) {
      return {
        type: FAILURE_TYPE.AUTOMATION,
        decision: HEAL_DECISION.HEAL,
        confidence: 'high',
        reason: 'Expected element not found in DOM — likely a selector or timing issue.',
      };
    }
    // Otherwise the element was found but value/text was wrong — real bug
    return {
      type: FAILURE_TYPE.ASSERTION,
      decision: HEAL_DECISION.BUG_REPORT,
      confidence: 'high',
      reason: 'Assertion failed — element exists but content or state is incorrect. This is likely a real application bug.',
    };
  }

  // ── URL/navigation verification ────────────────────────────────────────────
  if (['expecturl', 'verifyurl'].includes(action)) {
    return {
      type: FAILURE_TYPE.FUNCTIONAL,
      decision: HEAL_DECISION.BUG_REPORT,
      confidence: 'high',
      reason: 'Navigation went to the wrong URL — this is a functional bug, not a selector issue.',
    };
  }

  // ── Click/type/fill — check error type ────────────────────────────────────
  if (['click', 'type', 'fill'].includes(action)) {
    if (AUTOMATION_PATTERNS.some(p => p.test(err))) {
      return {
        type: FAILURE_TYPE.AUTOMATION,
        decision: HEAL_DECISION.HEAL,
        confidence: 'high',
        reason: 'Element not found or not interactable — the selector may have changed.',
      };
    }
    if (FUNCTIONAL_PATTERNS.some(p => p.test(err))) {
      return {
        type: FAILURE_TYPE.FUNCTIONAL,
        decision: HEAL_DECISION.BUG_REPORT,
        confidence: 'medium',
        reason: 'Interaction failed due to unexpected element state — may be a real bug.',
      };
    }
  }

  // ── Generic automation pattern match ──────────────────────────────────────
  if (AUTOMATION_PATTERNS.some(p => p.test(err))) {
    return {
      type: FAILURE_TYPE.AUTOMATION,
      decision: HEAL_DECISION.HEAL,
      confidence: 'medium',
      reason: 'Element not found or timing issue — auto-heal may resolve this.',
    };
  }

  if (FUNCTIONAL_PATTERNS.some(p => p.test(err))) {
    return {
      type: FAILURE_TYPE.FUNCTIONAL,
      decision: HEAL_DECISION.BUG_REPORT,
      confidence: 'medium',
      reason: 'Functional mismatch detected — this looks like a real application bug.',
    };
  }

  // ── Fallback ───────────────────────────────────────────────────────────────
  return {
    type: FAILURE_TYPE.UNKNOWN,
    decision: HEAL_DECISION.ASK,
    confidence: 'low',
    reason: 'Could not determine failure cause. Review manually.',
  };
}

/**
 * Human-readable label + colour for each decision type.
 * Used by the frontend to render the right UI.
 */
export const DECISION_META = {
  [HEAL_DECISION.HEAL]: {
    label:   'Automation issue — auto-heal available',
    colour:  'amber',
    canHeal: true,
  },
  [HEAL_DECISION.BUG_REPORT]: {
    label:   'Application bug — healing will not fix this',
    colour:  'red',
    canHeal: false,
  },
  [HEAL_DECISION.RETRY]: {
    label:   'Network issue — retry recommended',
    colour:  'sky',
    canHeal: false,
  },
  [HEAL_DECISION.ASK]: {
    label:   'Unknown cause — review required',
    colour:  'gray',
    canHeal: true,   // offer as option but don't default
  },
};