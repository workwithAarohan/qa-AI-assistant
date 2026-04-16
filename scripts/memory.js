import fs from 'fs';
import path from 'path';

// ── Helper: Tokenize ──
function tokenize(text) {
  if (!text) return [];
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
}

// ── Helper: Similarity ──
function calculateSimilarity(tokensA, tokensB) {
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

// ── Export 1: Find Plan (Object Standard) ──
export function findSimilarPlan(module, scenarioId, userPrompt = "") {
  const memoryPath = path.join(process.cwd(), 'memory.json');
  if (!fs.existsSync(memoryPath)) return null;

  let memory = {};
  try {
    memory = JSON.parse(fs.readFileSync(memoryPath, 'utf8'));
  } catch (e) {
    return null;
  }

  // 1. FAST PATH: Instant Exact Match (O(1) lookup)
  const exactKey = `${module}__${scenarioId}`;
  if (memory[exactKey]) {
    return memory[exactKey];
  }

  // 2. SMART PATH: Semantic Search over Object values
  let bestMatch = null;
  let highestScore = 0;
  const promptTokens = tokenize(userPrompt);
  
  // Convert object values to an array just for searching
  const allPlans = Object.values(memory); 

  for (const cached of allPlans) {
    if (userPrompt && promptTokens.length > 0) {
      const cachedTokens = tokenize(`${cached.scenario} ${cached.description || ''}`);
      const score = calculateSimilarity(promptTokens, cachedTokens);
      if (score > 0.4 && score > highestScore) {
        highestScore = score;
        bestMatch = cached;
      }
    }
  }

  return highestScore > 0.4 ? bestMatch : null;
}

// ── Export 2: Save Plan (Object Standard) ──
export function saveToMemory(plan) {
  const memoryPath = path.join(process.cwd(), 'memory.json');
  let memory = {};

  if (fs.existsSync(memoryPath)) {
    try {
      memory = JSON.parse(fs.readFileSync(memoryPath, 'utf8'));
    } catch (e) { memory = {}; }
  }

  // EVOLVING MEMORY: Save or overwrite using the specific key
  const key = `${plan.module}__${plan.scenario}`;
  memory[key] = { ...plan, savedAt: new Date().toISOString() };

  fs.writeFileSync(memoryPath, JSON.stringify(memory, null, 2));
}