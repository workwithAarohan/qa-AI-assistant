export function validatePlan(plan) {
  if (!plan) throw new Error("Plan is empty");

  if (!plan.module) throw new Error("Missing module");
  if (!plan.scenario) throw new Error("Missing scenario");
  if (!Array.isArray(plan.steps)) throw new Error("Steps must be array");

  for (const step of plan.steps) {
    if (!step.action) throw new Error("Step missing action");

    if (["type", "click", "expect"].includes(step.action)) {
      if (!step.selector) {
        throw new Error(`Missing selector for ${step.action}`);
      }
    }

    if (step.action === "type" && !step.value) {
      throw new Error("Type step missing value");
    }
  }

  return true;
}