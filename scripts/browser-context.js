import { chromium } from 'playwright';

export async function captureBrowserContext(url) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    if (url) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 8000 });
    }

    const snapshot = await page.evaluate(() => {
      // FIX 7: Only capture truly interactive + semantic elements.
      // Removed [id] — far too broad, captures every div/section with an id.
      // Removed generic 'a' — too many nav links. Keep only meaningful ones.
      const SELECTORS = [
        'input', 'select', 'textarea', 'button',
        '[type="submit"]', '[role="button"]',
        'a[href]:not([href^="#"])',  // real links, not anchors
        'h1', 'h2',
        '[id*="error"]', '[id*="success"]', '[id*="alert"]',
        '[class*="error"]', '[class*="success"]',
      ].join(', ');

      const seen = new Set();
      const elements = [];

      document.querySelectorAll(SELECTORS).forEach(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return; // skip hidden

        // Deduplicate by selector
        const id = el.id ? `#${el.id}` : null;
        const key = id || `${el.tagName}:${el.innerText?.trim().slice(0, 20)}`;
        if (seen.has(key)) return;
        seen.add(key);

        const entry = {
          tag:         el.tagName.toLowerCase(),
          id:          el.id || null,
          type:        el.getAttribute('type') || null,
          placeholder: el.getAttribute('placeholder') || null,
          text:        el.innerText?.trim().slice(0, 60) || null,
          href:        el.getAttribute('href') || null,
          role:        el.getAttribute('role') || null,
          ariaLabel:   el.getAttribute('aria-label') || null,
          name:        el.getAttribute('name') || null,
        };

        // Strip nulls to keep the payload compact
        Object.keys(entry).forEach(k => entry[k] === null && delete entry[k]);
        elements.push(entry);
      });

      return {
        url:      window.location.href,
        title:    document.title,
        elements: elements.slice(0, 40), // hard cap — LLM doesn't need more than 40
      };
    });

    await browser.close();

    // Format as readable text — more useful to the LLM than raw JSON
    const lines = [
      `URL: ${snapshot.url}`,
      `Title: ${snapshot.title}`,
      `Elements (${snapshot.elements.length}):`,
    ];

    for (const el of snapshot.elements) {
      const parts = [el.tag];
      if (el.id)          parts.push(`#${el.id}`);
      if (el.type)        parts.push(`[type=${el.type}]`);
      if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
      if (el.text)        parts.push(`"${el.text}"`);
      if (el.href)        parts.push(`href="${el.href}"`);
      if (el.ariaLabel)   parts.push(`aria="${el.ariaLabel}"`);
      lines.push('  ' + parts.join(' '));
    }

    return lines.join('\n');

  } catch (err) {
    try { await browser.close(); } catch {}
    return `Could not capture browser context: ${err.message}`;
  }
}