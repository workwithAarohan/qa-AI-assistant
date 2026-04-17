import fs from 'fs';
import path from 'path';

const DOCS_DIR = './docs';

export function loadAllDocs() {
  if (!fs.existsSync(DOCS_DIR)) return [];
  return fs.readdirSync(DOCS_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => ({
      name: f.replace('.md', ''),
      content: fs.readFileSync(path.join(DOCS_DIR, f), 'utf-8'),
    }));
}

function score(doc, prompt) {
  const p = prompt.toLowerCase();
  const name = doc.name.toLowerCase();
  const content = doc.content.toLowerCase();
  let hits = 0;
  // Strong signal: doc name mentioned directly
  if (p.includes(name)) hits += 10;
  // Weak signal: words in content
  const words = p.split(/\s+/).filter(w => w.length > 3);
  for (const word of words) {
    if (content.includes(word)) hits += 1;
  }
  return hits;
}

export function getRelevantContext(prompt) {
  const docs = loadAllDocs();
  if (!docs.length) return '';
  const scored = docs
    .map(doc => ({ ...doc, score: score(doc, prompt) }))
    .filter(doc => doc.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);
  return scored
    .map(doc => `### MODULE: ${doc.name}\n${doc.content}`)
    .join('\n\n');
}

export function extractBaseUrl(prompt) {
  const docs = loadAllDocs();
  if (!docs.length) return null;
  const scored = docs
    .map(doc => ({ ...doc, score: score(doc, prompt) }))
    .filter(doc => doc.score > 0)
    .sort((a, b) => b.score - a.score);
  for (const doc of scored) {
    const match = doc.content.match(/##\s*URL\s*\n(https?:\/\/[^\s]+)/i)
      || doc.content.match(/URL:\s*(https?:\/\/[^\s]+)/i);
    if (match) return match[1].trim();
  }
  return null;
}

export function extractDocScenarios(prompt) {
  const docs = loadAllDocs();
  if (!docs.length) return [];
  const scored = docs
    .map(doc => ({ ...doc, score: score(doc, prompt) }))
    .filter(doc => doc.score > 0)
    .sort((a, b) => b.score - a.score);

  // FIX: Only use the BEST matching doc — not top 2.
  // Using top 2 caused login + dashboard both returning scenarios when "login"
  // appeared in dashboard.md body text.
  const bestDoc = scored[0];
  if (!bestDoc) return [];

  const section = bestDoc.content.match(/##\s*Test Scenarios\s*\n([\s\S]*?)(?=\n##|$)/i);
  if (!section) return [];

  return section[1].trim().split('\n')
    .map(line => {
      const match = line.match(/[-*]\s*([a-z_]+):\s*(.+)/i);
      if (!match) return null;
      return {
        id:          match[1].trim().toLowerCase(),
        name:        match[1].trim().replace(/_/g, ' '),
        description: match[2].trim(),
        module:      bestDoc.name,
      };
    })
    .filter(Boolean);
}