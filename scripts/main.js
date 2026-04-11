import dotenv from 'dotenv';
dotenv.config();

import { generateSteps, validatePlan, runSteps } from './index.js';
import { getFromMemory, saveToMemory } from "./memory.js";

function generateKey(input) {
  return input.toLowerCase().replace(/\s+/g, "_");
}

(async () => {
  try {
    const userInput = "Test login with invalid password";
    const key = generateKey(userInput);

    console.log("Checking memory...");
    let plan = getFromMemory(key);

    if (plan) {
      console.log("Memory HIT!");
    } else {
      console.log("Memory MISS → calling LLM...");
      plan = await generateSteps(userInput);

      validatePlan(plan);

      console.log("Saving to memory...");
      saveToMemory(key, plan);
    }

    console.log("Executing...");
    const result = await runSteps(plan.steps);

    if (result.status === "success") {
      console.log("Execution success → saving/updating memory");
      saveToMemory(key, plan);
    } else {
      console.log("Execution failed → do not save");
    }

    console.log("FINAL RESULT:");
    console.log(JSON.stringify(result, null, 2));

  } catch (err) {
    console.error("SYSTEM ERROR:", err.message);
  }
})();