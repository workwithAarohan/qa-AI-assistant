/**
 * conversation-speaker.js
 *
 * User-facing language for the structured conversation decision.
 * Internal words like slot/gap/confidence should never leak from here.
 */

export function speakClarification(decision, appName = 'this app') {
  const gap = decision.gaps?.[0];
  if (!gap) return `I can help with that. Which part of ${appName} should we focus on?`;

  if (gap.slot === 'scope') {
    const opts = (gap.options || []).slice(0, 5);
    return opts.length
      ? `I can do that. Which area should I focus on: ${opts.join(', ')}?`
      : `I can do that. Should I focus on one module, or the whole app?`;
  }

  return `I’m close. What part should I focus on first?`;
}

export function speakPlanReady(plan) {
  const layers = plan.layers || [];
  const modules = [...new Set(layers.flatMap(l => (l.scenarios || []).map(s => s.module).filter(Boolean)))];
  const order = (plan.recommended_order?.length ? plan.recommended_order : layers.map(l => l.type))
    .map(humanLayer);

  const moduleText = modules.length > 1
    ? `${modules.length} modules`
    : modules[0] ? `the ${modules[0]} module` : 'this feature';

  const orderText = order.length ? order.join(' -> ') : 'UI testing';
  return `I mapped this into the planning workspace: ${moduleText}, ${layers.length || 1} layer${layers.length === 1 ? '' : 's'}, ordered as ${orderText}. Review the visual plan, then use Run plan or a layer button when you’re ready.`;
}

export function speakExecutionProposal(scenarios = []) {
  if (scenarios.length === 1) {
    const s = scenarios[0];
    return `I found **${s.name}** in the ${s.module} module. I’ve highlighted the matching scenario in the dashboard; use its Run button when you want to execute it.`;
  }

  const grouped = scenarios.reduce((acc, s) => {
    (acc[s.module] = acc[s.module] || []).push(s);
    return acc;
  }, {});
  const summary = Object.entries(grouped)
    .map(([module, rows]) => `${module}: ${rows.length}`)
    .join(', ');

  return `I found ${scenarios.length} matching scenarios (${summary}). I’ll keep execution explicit: use a scenario Run button, module Run all, or the regression control.`;
}

export function speakExploreFallback(response, appName = 'this app') {
  return response || `I can help explore, plan, design, or run QA checks for ${appName}.`;
}

export function speakDesignPrompt(decision) {
  const moduleName = decision.intent?.scope?.module?.name;
  return moduleName
    ? `I can draft a reusable test scenario for ${moduleName}. Tell me the user flow and expected result, and I’ll turn it into steps.`
    : `I can draft a reusable test scenario. Tell me the module, the user flow, and the expected result.`;
}

function humanLayer(type) {
  return ({
    API: 'API checks',
    DATA_VALIDATION: 'data validation',
    UI: 'UI testing',
    PERFORMANCE: 'performance testing',
  })[type] || String(type || 'testing').replace(/_/g, ' ').toLowerCase();
}
