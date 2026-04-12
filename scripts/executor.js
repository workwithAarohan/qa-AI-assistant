import { chromium } from "playwright";

async function smartClick(page, selector) {
  try {
    await page.click(selector);
    return { method: "primary" };
  } catch {
    console.log("Fallback to role-based click...");
    await page.getByRole("button", { name: "Login" }).click();
    return { method: "fallback" };
  }
}

export async function runSteps(steps, onStep = () => {}) {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  let results = [];

  for (const step of steps) {
    try {
      console.log("Executing:", step);
      onStep(step, "running");

      let methodUsed = "primary";

      switch (step.action) {
        case "navigate":
          await page.goto(step.value);
          break;

        case "type":
          await page.fill(step.selector, step.value);
          break;

        case "click":
          {
            const clickResult = await smartClick(page, step.selector);
            methodUsed = clickResult.method;
          }
          break;

        case "expect":
          await page.waitForSelector(step.selector);
          break;

        case "wait":
          await page.waitForTimeout(step.value);
          break;

        default:
          throw new Error("Unknown action");
      }

      onStep(step, "success");

      const screenshot = await page.screenshot({ encoding: 'base64' });
      onStep(step, 'success', screenshot);

      results.push({
        step,
        status: "success",
        methodUsed,
      });

    } catch (err) {
      console.log("Step failed:", step);
      onStep(step, "failed");

      await browser.close();

      return {
        status: "failed",
        failedStep: step,
        error: err.message,
        results,
      };
    }
  }

  await browser.close();

  return {
    status: "success",
    results,
  };
}