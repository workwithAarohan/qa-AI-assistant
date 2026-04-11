import dotenv from 'dotenv';
dotenv.config();

import { generateSteps, validatePlan, runSteps } from './index.js';

(async () => {
  try {
    const userInput = "Test login with invalid password";

    console.log("Generating steps...");
    const plan = await generateSteps(userInput);

    console.log("PLAN:", JSON.stringify(plan, null, 2));

    console.log("Validating...");
    validatePlan(plan);

    console.log("Executing...");
    const result = await runSteps(plan.steps);

    console.log("FINAL RESULT:");
    console.log(JSON.stringify(result, null, 2));

  } catch (err) {
    console.error("SYSTEM ERROR:", err.message);
  }
})();