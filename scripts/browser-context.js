import { chromium } from 'playwright';

export async function captureBrowserContext(url) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  try {
    if (url) await page.goto(url, { waitUntil: 'networkidle' });

    // This script runs in the browser and strips away everything non-essential
    const prunedDOM = await page.evaluate(() => {
      const selectors = 'button, input, select, textarea, a, [role="button"], [id], h1, h2, .error, .success';
      const elements = document.querySelectorAll(selectors);
      
      return Array.from(elements).map(el => {
        const rect = el.getBoundingClientRect();
        // Only capture visible elements
        if (rect.width === 0 || rect.height === 0) return null;

        return {
          tag: el.tagName.toLowerCase(),
          id: el.id || null,
          text: el.innerText?.trim().substring(0, 50) || null,
          placeholder: el.getAttribute('placeholder') || null,
          type: el.getAttribute('type') || null,
          role: el.getAttribute('role') || null,
          ariaLabel: el.getAttribute('aria-label') || null
        };
      }).filter(Boolean);
    });

    await browser.close();
    return JSON.stringify(prunedDOM);
  } catch (err) {
    await browser.close();
    return "Error capturing DOM: " + err.message;
  }
}