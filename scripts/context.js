/**
 * context-v2.js
 * Drop-in replacement for context.js that supports per-app docsDir.
 * Replace import in server-v2.js:
 *   import { loadAllDocs } from './context.js'
 * with:
 *   import { loadAllDocs } from './context-v2.js'
 */

import fs from 'fs';
import path from 'path';

const DEFAULT_DOCS = process.env.DOCS_DIR || './docs';

export function loadAllDocs(docsDir = DEFAULT_DOCS) {
  const dir = docsDir || DEFAULT_DOCS;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => ({
      name: f.replace('.md', ''),
      content: fs.readFileSync(path.join(dir, f), 'utf-8'),
    }));
}

export function getRelevantContext(prompt, docsDir = DEFAULT_DOCS) {
  const docs = loadAllDocs(docsDir);
  if (!docs.length) return '';
  const p = prompt.toLowerCase();
  const scored = docs
    .map(doc => {
      let hits = 0;
      if (p.includes(doc.name.toLowerCase())) hits += 10;
      const words = p.split(/\s+/).filter(w => w.length > 3);
      for (const w of words) if (doc.content.toLowerCase().includes(w)) hits++;
      return { ...doc, hits };
    })
    .filter(d => d.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 2);
  return scored.map(d => `### MODULE: ${d.name}\n${d.content}`).join('\n\n');
}

export function extractBaseUrl(prompt, docsDir = DEFAULT_DOCS) {
  const docs = loadAllDocs(docsDir);
  for (const doc of docs) {
    const m = doc.content.match(/##\s*URL\s*\n(https?:\/\/[^\s]+)/i);
    if (m && prompt.toLowerCase().includes(doc.name.toLowerCase())) return m[1].trim();
  }
  return null;
}

export function extractDocScenarios(prompt, docsDir = DEFAULT_DOCS) {
  const docs = loadAllDocs(docsDir);
  const p = prompt.toLowerCase();
  const bestDoc = docs
    .map(d => {
      let score = 0;
      if (p.includes(d.name.toLowerCase())) score += 10;
      p.split(/\s+/).filter(w=>w.length>3).forEach(w => { if (d.content.toLowerCase().includes(w)) score++; });
      return { ...d, score };
    })
    .filter(d => d.score > 0)
    .sort((a,b) => b.score - a.score)[0];

  if (!bestDoc) return [];
  const sec = bestDoc.content.match(/##\s*Test Scenarios\s*\n([\s\S]*?)(?=\n##|$)/i);
  if (!sec) return [];
  return sec[1].trim().split('\n')
    .map(line => { const m = line.match(/[-*]\s*([a-z_]+):\s*(.+)/i); return m ? { id: m[1].toLowerCase(), name: m[1].replace(/_/g,' '), description: m[2].trim(), module: bestDoc.name } : null; })
    .filter(Boolean);
}