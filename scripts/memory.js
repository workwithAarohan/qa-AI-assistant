import fs from 'fs';
import path from 'path';

function safeAppId(appId = 'testapp') {
  return String(appId || 'testapp').toLowerCase().replace(/[^a-z0-9_-]/g, '_') || 'testapp';
}

function memoryPathForApp(appId = 'testapp') {
  const dir = path.join(process.cwd(), 'memory');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${safeAppId(appId)}.json`);
}

function loadMemory(appId = 'testapp') {
  const memoryPath = memoryPathForApp(appId);
  if (!fs.existsSync(memoryPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(memoryPath, 'utf8'));
  } catch (e) {
    return {};
  }
}

function writeMemory(appId = 'testapp', memory = {}) {
  fs.writeFileSync(memoryPathForApp(appId), JSON.stringify(memory, null, 2));
}

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
export function findSimilarPlan(appId, module, scenarioId, userPrompt = "") {
  const memory = loadMemory(appId);

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
export function saveToMemory(appId, plan) {
  const memory = loadMemory(appId);

  // EVOLVING MEMORY: Save or overwrite using the specific key
  const key = `${plan.module}__${plan.scenario}`;
  memory[key] = { ...plan, savedAt: new Date().toISOString() };

  writeMemory(appId, memory);
}

export function deleteFromMemory(appId, module, scenarioId) {
  const memory = loadMemory(appId);

  const key = `${module}__${scenarioId}`;
  const existed = !!memory[key];
  if (existed) {
    delete memory[key];
    writeMemory(appId, memory);
  }
  return existed;
}

export function listMemory(appId = null) {
  if (appId) return Object.values(loadMemory(appId));
  const dir = path.join(process.cwd(), 'memory');
  if (!fs.existsSync(dir)) return [];
  const plans = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    plans.push(...Object.values(loadMemory(file.replace(/\.json$/, ''))));
  }
  return plans;
}

export function repairMemory(appId = null) {
  const appIds = appId
    ? [safeAppId(appId)]
    : fs.existsSync(path.join(process.cwd(), 'memory'))
      ? fs.readdirSync(path.join(process.cwd(), 'memory')).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''))
      : [];
  let total = 0;
  for (const id of appIds) {
    const memory = loadMemory(id);
    total += Object.keys(memory).length;
    writeMemory(id, memory);
  }
  return { total, changed: 0 };
}
