/**
 * conversation-decision.js
 *
 * Deterministic conversation gate for QA Sentinel.
 * It separates "what should the system do?" from "how should we say it?".
 */

const MODE = {
  EXPLORE: 'EXPLORE',
  PLAN: 'PLAN',
  DESIGN: 'DESIGN',
  EXECUTE: 'EXECUTE',
  RESULT: 'RESULT',
  FALLBACK: 'FALLBACK',
};

export function decideConversation(userInput, appContext = {}, sessionCtx = {}) {
  const text = String(userInput || '').trim();
  const lower = text.toLowerCase();
  const docs = appContext.docs || [];
  const history = sessionCtx.history || [];
  const catalog = buildCatalog(docs);
  const priorScope = inferScopeFromHistory(history, catalog);
  const scope = extractScope(lower, catalog, priorScope);

  const mode = detectMode(lower, history);
  const intent = extractIntent(mode, scope, catalog);
  const gaps = detectGaps(mode, intent, catalog);

  return {
    mode,
    intent,
    gaps,
    scenarios: intent.scenarios || [],
    nextAction: selectNextAction(mode, gaps),
    confidence: scoreConfidence(mode, intent, gaps),
    source: 'conversation-decision',
  };
}

export function buildCatalog(docs = []) {
  const modules = docs.map(doc => {
    const sec = doc.content.match(/##\s*Test Scenarios\s*\n([\s\S]*?)(?=\n##|$)/i);
    const scenarios = sec
      ? sec[1].trim().split('\n').map(line => {
          const m = line.match(/[-*]\s*([a-z_]+):\s*(.+)/i);
          return m ? {
            id: m[1].trim().toLowerCase(),
            name: m[1].trim().replace(/_/g, ' '),
            description: m[2].trim(),
            module: doc.name,
          } : null;
        }).filter(Boolean)
      : [];
    return { id: doc.name, name: doc.name, scenarios };
  });

  return {
    modules,
    scenarios: modules.flatMap(m => m.scenarios),
  };
}

function detectMode(lower, history) {
  if (isAffirmative(lower) && lastAgentWasPlanning(history)) return MODE.PLAN;

  if (/\b(why|what|explain|summari[sz]e|summary|result|report)\b.*\b(fail|failed|last|run|test|heal|healed|pass|passed)\b/.test(lower)) return MODE.RESULT;
  if (/\b(last test|last run|test result|run result|why did it fail|what failed|failed test)\b/.test(lower)) return MODE.RESULT;
  if (/\b(create|build|design|draft|add)\b.*\b(test|scenario|case|flow)\b/.test(lower)) return MODE.DESIGN;
  if (/\b(test plan|plan|coverage|comprehensive|properly|full coverage|end[- ]?to[- ]?end|e2e|strategy|layers?|risk)\b/.test(lower)) return MODE.PLAN;
  if (/\b(what can|show|list|explain|how does|tell me about|understand)\b/.test(lower)) return MODE.EXPLORE;
  if (/\b(run|execute|start)\b|\b(test|verify|check|validate)\b/.test(lower)) return MODE.EXECUTE;

  return MODE.FALLBACK;
}

function extractScope(lower, catalog, priorScope) {
  const module = findModule(lower, catalog) || priorScope.module || null;
  const scenario = findScenario(lower, catalog) || null;
  return {
    module,
    scenario,
    testType: inferTestType(lower),
  };
}

function extractIntent(mode, scope, catalog) {
  const scenarios = resolveScenarios(mode, scope, catalog);
  return {
    task: mode === MODE.PLAN ? 'plan_tests'
      : mode === MODE.DESIGN ? 'design_test'
      : mode === MODE.EXECUTE ? 'run_tests'
      : mode === MODE.RESULT ? 'inspect_results'
      : mode === MODE.EXPLORE ? 'explore'
      : 'unknown',
    scope,
    scenarios,
  };
}

function resolveScenarios(mode, scope, catalog) {
  if (mode !== MODE.EXECUTE) return [];
  if (scope.scenario) return [scope.scenario];
  if (scope.module) return catalog.scenarios.filter(s => s.module === scope.module.id);
  if (scope.testType === 'regression') return catalog.scenarios;
  return [];
}

function detectGaps(mode, intent, catalog) {
  const gaps = [];
  if (mode === MODE.EXECUTE && !intent.scenarios.length) {
    gaps.push({
      type: 'missing',
      slot: 'scope',
      severity: 'critical',
      options: catalog.modules.map(m => m.name),
    });
  }
  if (mode === MODE.PLAN && !intent.scope.module && catalog.modules.length > 1) {
    gaps.push({
      type: 'soft_missing',
      slot: 'scope',
      severity: 'warning',
      options: catalog.modules.map(m => m.name),
    });
  }
  return gaps;
}

function selectNextAction(mode, gaps) {
  if (mode === MODE.FALLBACK) return { type: 'fallback_llm', confirmationRequired: false };
  if (gaps.some(g => g.severity === 'critical')) return { type: 'ask_question', confirmationRequired: false };
  if (mode === MODE.PLAN) return { type: 'propose_plan', confirmationRequired: true };
  if (mode === MODE.DESIGN) return { type: 'design', confirmationRequired: false };
  if (mode === MODE.EXECUTE) return { type: 'propose_execution', confirmationRequired: true };
  if (mode === MODE.RESULT) return { type: 'answer_results', confirmationRequired: false };
  return { type: 'answer', confirmationRequired: false };
}

function scoreConfidence(mode, intent, gaps) {
  const modeScore = mode === MODE.FALLBACK ? 0.35 : 0.88;
  const scopeScore = intent.scope?.module || intent.scope?.scenario || intent.scope?.testType === 'regression' ? 0.85 : 0.55;
  const gapPenalty = gaps.some(g => g.severity === 'critical') ? 0.35 : gaps.length ? 0.15 : 0;
  return {
    mode: modeScore,
    intent: Math.max(0.1, scopeScore - gapPenalty),
    readiness: Math.max(0.1, 0.9 - gapPenalty),
  };
}

function findModule(lower, catalog) {
  return catalog.modules.find(m => lower.includes(m.id.toLowerCase()) || lower.includes(m.name.toLowerCase())) || null;
}

function findScenario(lower, catalog) {
  return catalog.scenarios.find(s =>
    lower.includes(s.id.toLowerCase()) ||
    lower.includes(s.name.toLowerCase())
  ) || null;
}

function inferTestType(lower) {
  if (/\b(regression|all tests|everything|whole system|full suite)\b/.test(lower)) return 'regression';
  if (/\b(smoke|quick|sanity)\b/.test(lower)) return 'smoke';
  if (/\b(performance|perf|speed)\b/.test(lower)) return 'performance';
  if (/\b(api)\b/.test(lower)) return 'api';
  if (/\b(ui|browser|end[- ]?to[- ]?end|e2e)\b/.test(lower)) return 'ui';
  return null;
}

function inferScopeFromHistory(history, catalog) {
  const recent = history.slice(-6).map(h => h.text || '').join(' ').toLowerCase();
  return {
    module: findModule(recent, catalog),
  };
}

function isAffirmative(lower) {
  return /^(yes|yeah|yep|sure|ok|okay|please do|do it|go ahead|sounds good|correct|proceed)\b/.test(lower);
}

function lastAgentWasPlanning(history) {
  const lastAgent = [...history].reverse().find(h => h.role === 'agent');
  if (!lastAgent) return false;
  return /\b(plan|coverage|comprehensive|layers?|test strategy|visual plan)\b/i.test(lastAgent.text || '');
}

export { MODE };
