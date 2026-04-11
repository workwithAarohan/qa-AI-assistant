import dotenv from 'dotenv';
dotenv.config();

import { generateSteps } from "./index.js";

(async () => {
  try {
    const result = await generateSteps("Test login with invalid password");
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Error generating steps:', err);
  }
})();