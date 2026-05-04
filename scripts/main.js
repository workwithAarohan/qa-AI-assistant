import dotenv from 'dotenv';
dotenv.config();

import { generateSteps, validatePlan, runSteps, fixSteps } from './index.js';
import { findSimilarPlan, saveToMemory } from "./memory.js";

(async () => {
  try {
    const userInput = "Test login with invalid password";
    console.log("Checking memory...");
    let plan = findSimilarPlan('testapp', 'login', 'invalid_password', userInput);

    if (plan) {
      console.log("Memory HIT!");
    } else {
      console.log("Memory MISS → calling LLM...");
      plan = await generateSteps(userInput);

      validatePlan(plan);

      console.log("Saving to memory...");
      saveToMemory('testapp', plan);
    }

    console.log("Executing...");
    const result = await runSteps(plan.steps);

    if (result.status === "failed") {
      console.log("Execution failed → attempting auto-heal...");

      const fixedPlan = await fixSteps(plan, result.error);

      console.log("Fixed Plan:", JSON.stringify(fixedPlan, null, 2));

      validatePlan(fixedPlan);

      console.log("Retrying with fixed plan...");
      result = await runSteps(fixedPlan.steps);

      if (result.status === "success") {
        console.log("Heal successful → updating memory");
        saveToMemory('testapp', fixedPlan);
      } else {
        console.log("Heal failed");
      }

    } else {
      console.log("Execution success");
      saveToMemory('testapp', plan);
    }

    console.log("FINAL RESULT:");
    console.log(JSON.stringify(result, null, 2));

  } catch (err) {
    console.error("SYSTEM ERROR:", err.message);
  }
})();
