// Action whitelist — covers both canonical names and all LLM variants
// Must stay in sync with ACTION_MAP in executor.js
const VALID_ACTIONS = new Set([
  // Canonical executor actions
  'navigate', 'goto', 'type', 'fill', 'click', 'expect', 'expecturl', 'verifyurl',
  'asserttext', 'waitfornavigation', 'wait', 'press', 'verify', 'assert', 'select',
  // LLM variants (normalized by stripping _ - spaces)
  'navigateto', 'fillfield', 'inputtext', 'entertext', 'setvalue',
  'clickbutton', 'clickelement', 'tapbutton', 'selectoption', 'chooseoption',
  'assertelementvisible', 'assertvisible', 'assertelement', 'assertelementcount',
  'verifyelement', 'verifyvisible', 'checkvisible', 'verifytext', 'assertcontains',
  'interactwith', 'waitfor', 'pause', 'checkurl', 'asserturl',
]);

export function validatePlan(plan) {
  if (!plan) throw new Error('Plan is empty');
  if (!plan.module) throw new Error('Missing module');
  if (!plan.scenario) throw new Error('Missing scenario');
  if (!Array.isArray(plan.steps)) throw new Error('Steps must be an array');

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    if (!step.action) throw new Error(`Step ${i + 1} missing action`);

    const normalized = step.action.toLowerCase().replace(/[_\s\-]/g, '');

    if (!VALID_ACTIONS.has(normalized)) {
      throw new Error(
        `Step ${i + 1} has invalid action "${step.action}". ` +
        `Supported: navigate, type, fill, click, expect, expectUrl, assertText, ` +
        `waitForNavigation, wait, select`
      );
    }

    // selector required for interaction/assertion steps
    const needsSelector = new Set(['type','fill','click','expect','select','asserttext','verify','assert','press']);
    if (needsSelector.has(normalized) && !step.selector) {
      throw new Error(`Step ${i + 1} action "${step.action}" missing selector`);
    }

    // value required for navigation/url steps
    const needsValue = new Set(['navigate','goto','navigateto','expecturl','verifyurl','verifyurl','checkurl','asserturl']);
    if (needsValue.has(normalized) && !step.value) {
      throw new Error(`Step ${i + 1} action "${step.action}" missing value (URL)`);
    }
  }

  return true;
}