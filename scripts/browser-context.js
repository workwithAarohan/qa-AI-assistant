import { chromium } from 'playwright';

const DEFAULT_URL = process.env.BASE_URL || 'http://localhost:4000/testapp';

function sanitizeHtml(html, maxLen = 10000) {
  // remove scripts and large inline data to keep prompt small
  const noScripts = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  // collapse whitespace
  const collapsed = noScripts.replace(/\s+/g, ' ').trim();
  return collapsed.slice(0, maxLen);
}

export async function getBrowserContext(url = DEFAULT_URL, { timeout = 8000, headless = true } = {}) {
  if (!url) url = DEFAULT_URL;
  const browser = await chromium.launch({ headless });
  const page = await browser.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });

    const html = await page.content();
    const sanitized = sanitizeHtml(html);

    const buf = await page.screenshot({ fullPage: false });
    const screenshotBase64 = buf.toString('base64');

    await browser.close();

    return { url, html: sanitized, screenshotBase64 };
  } catch (err) {
    try { await browser.close(); } catch {}
    throw err;
  }
}

// alias for backward compatibility
export const captureBrowserContext = getBrowserContext;

