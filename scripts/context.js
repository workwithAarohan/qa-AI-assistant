import fs from 'fs';
import path from 'path';

const DOCS_DIR = './docs';

// Load all markdown docs from the docs folder
function loadAllDocs() {
  if (!fs.existsSync(DOCS_DIR)) return [];

  return fs.readdirSync(DOCS_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => ({
      name: f.replace('.md', ''),
      content: fs.readFileSync(path.join(DOCS_DIR, f), 'utf-8')
    }));
}

// Score how relevant a doc is to the user's prompt
function score(doc, prompt) {
  const p = prompt.toLowerCase();
  const name = doc.name.toLowerCase();
  const content = doc.content.toLowerCase();

  let hits = 0;
  if (p.includes(name)) hits += 3;         // doc name mentioned directly
  const words = p.split(/\s+/);
  for (const word of words) {
    if (word.length > 3 && content.includes(word)) hits++;
  }
  return hits;
}

// Return only the docs relevant to this prompt
export function getRelevantContext(prompt) {
  const docs = loadAllDocs();
  if (docs.length === 0) return '';

  const scored = docs
    .map(doc => ({ ...doc, score: score(doc, prompt) }))
    .filter(doc => doc.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3); // top 3 most relevant docs

  if (scored.length === 0) return '';

  return scored
    .map(doc => `--- ${doc.name}.md ---\n${doc.content}`)
    .join('\n\n');
}