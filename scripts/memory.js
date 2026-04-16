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

  // 1. PRIMARY: Exact ID Match (Most Reliable)
  // We check if the unique key exists in our object
  const exactKey = `${module}__${scenarioId}`;
  if (memory[exactKey]) {
    return memory[exactKey];
  }

  // 2. SECONDARY: Slug Match
  // If the user said "Test Login", look for any key ending in "__login"
  if (scenarioId) {
    const allKeys = Object.keys(memory);
    const slugMatch = allKeys.find(k => k.endsWith(`__${scenarioId}`));
    if (slugMatch) return memory[slugMatch];
  }

  // 3. TERTIARY: Fuzzy Semantic (Only if prompt is provided and ID match failed)
  if (userPrompt && userPrompt.length > 5) {
    const promptTokens = tokenize(userPrompt);
    let bestMatch = null;
    let highestScore = 0;

    for (const key in memory) {
      const cached = memory[key];
      // Match against the scenario name stored inside the plan
      const cachedTokens = tokenize(`${cached.scenario || ''} ${key.replace(/__/g, ' ')}`);
      const score = calculateSimilarity(promptTokens, cachedTokens);
      
      if (score > 0.7 && score > highestScore) { // Increased threshold to 0.7 to avoid "ridiculous" matches
        highestScore = score;
        bestMatch = cached;
      }
    }
    return bestMatch;
  }

  return null;
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