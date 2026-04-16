import fs from 'fs';
import path from 'path';

const DOCS_DIR = './docs';

// ── Load all docs ─────────────────────────────────────────────────────────────

export function loadAllDocs() {
  if (!fs.existsSync(DOCS_DIR)) return [];
  return fs.readdirSync(DOCS_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => ({
      name: f.replace('.md', ''),
      content: fs.readFileSync(path.join(DOCS_DIR, f), 'utf-8'),
    }));
}

// ── Relevance scoring ─────────────────────────────────────────────────────────

function score(doc, prompt) {
  const p = prompt.toLowerCase();
  const name = doc.name.toLowerCase();
  const content = doc.content.toLowerCase();
  let hits = 0;
  if (p.includes(name)) hits += 4;
  const words = p.split(/\s+/).filter(w => w.length > 3);
  for (const word of words) {
    if (content.includes(word)) hits++;
  }
  return hits;
}

// ── Get relevant doc context (text) ──────────────────────────────────────────

export function getRelevantContext(prompt) {
  const docs = loadAllDocs();
  if (!docs.length) return '';

  const scored = docs
    .map(doc => ({ ...doc, score: score(doc, prompt) }))
    .filter(doc => doc.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);

  return scored
    .map(doc => {
      // Priority extraction: URL and Scenarios
      const urlPart = doc.content.match(/## URL[\s\S]*?(?=\n##|$)/i)?.[0] || '';
      const behaviorPart = doc.content.match(/## (Behaviour|Logic)[\s\S]*?(?=\n##|$)/i)?.[0] || '';
      
      return `### MODULE: ${doc.name}\n${urlPart}\n${behaviorPart}\n${doc.content}`;
    })
    .join('\n\n');
}

// ── Extract base URL from doc context ─────────────────────────────────────────
// Reads the ## URL section from the most relevant doc.
// This prevents the LLM from guessing or hallucinating URLs.

export function extractBaseUrl(prompt) {
  const docs = loadAllDocs();
  if (!docs.length) return null;

  const scored = docs
    .map(doc => ({ ...doc, score: score(doc, prompt) }))
    .filter(doc => doc.score > 0)
    .sort((a, b) => b.score - a.score);

  for (const doc of scored) {
    // Match "## URL\nhttp://..." or "URL: http://..."
    const match = doc.content.match(/##\s*URL\s*\n(https?:\/\/[^\s]+)/i)
      || doc.content.match(/URL:\s*(https?:\/\/[^\s]+)/i);
    if (match) return match[1].trim();
  }

  return null;
}

// ── Extract all scenario ids declared in docs ─────────────────────────────────
// Reads "## Test Scenarios" sections so we know what is documented
// without needing an LLM call.

export function extractDocScenarios(prompt) {
  const docs = loadAllDocs();
  if (!docs.length) return [];

  const scored = docs
    .map(doc => ({ ...doc, score: score(doc, prompt) }))
    .filter(doc => doc.score > 0)
    .sort((a, b) => b.score - a.score);

  const scenarios = [];

  for (const doc of scored.slice(0, 2)) {
    const section = doc.content.match(/##\s*Test Scenarios\s*\n([\s\S]*?)(?=\n##|$)/i);
    if (!section) continue;

    const lines = section[1].trim().split('\n');
    for (const line of lines) {
      // Format: "- scenario_id: description"
      const match = line.match(/[-*]\s*([a-z_]+):\s*(.+)/i);
      if (match) {
        scenarios.push({
          id: match[1].trim().toLowerCase(),
          name: match[1].trim().replace(/_/g, ' '),
          description: match[2].trim(),
          module: doc.name,
        });
      }
    }
  }

  return scenarios;
}