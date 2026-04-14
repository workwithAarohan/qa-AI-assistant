import fs from 'fs';

const MEMORY_FILE = './memory.json';

// ── Storage ───────────────────────────────────────────────────────────────────

function load() {
  if (!fs.existsSync(MEMORY_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8')); } catch { return {}; }
}

function save(memory) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
}

// ── Key generation ────────────────────────────────────────────────────────────
// Canonical key = module__scenario, both normalized.
// This is the single source of truth for how plans are identified.

function normalize(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function canonicalKey(plan) {
  const m = normalize(plan?.module);
  const s = normalize(plan?.scenario);
  if (!m || !s) return null;
  return `${m}__${s}`;
}

// ── Write ─────────────────────────────────────────────────────────────────────
// Always saves under canonical key.
// If a duplicate (same module+scenario, different steps) exists, it overwrites.

export function saveToMemory(plan) {
  const key = canonicalKey(plan);
  if (!key || !plan?.steps?.length) return null;

  const memory = load();
  memory[key] = {
    module:   normalize(plan.module),
    scenario: normalize(plan.scenario),
    steps:    plan.steps,
    savedAt:  new Date().toISOString(),
  };
  save(memory);
  return key;
}

// ── Read — exact ──────────────────────────────────────────────────────────────
// Fast O(1) lookup by canonical key.

export function getFromMemory(plan) {
  const key = canonicalKey(plan);
  if (!key) return null;
  return load()[key] || null;
}

// ── Read — fuzzy ──────────────────────────────────────────────────────────────
// Tries exact first, then falls back to partial matching.
// Handles cases like "invalid_password" matching "invalid_credentials"
// when both share the same module and a common keyword.

export function findSimilarPlan(module, scenario) {
  const normModule   = normalize(module);
  const normScenario = normalize(scenario);

  if (!normModule || !normScenario) return null;

  const memory = load();

  // 1. Exact match
  const exactKey = `${normModule}__${normScenario}`;
  if (memory[exactKey]) return memory[exactKey];

  // 2. Module matches + scenario shares a meaningful keyword
  const scenarioWords = normScenario.split('_').filter(w => w.length > 3);

  let bestMatch = null;
  let bestScore = 0;

  for (const [, plan] of Object.entries(memory)) {
    if (normalize(plan.module) !== normModule) continue;

    const planScenarioWords = normalize(plan.scenario).split('_');
    const sharedWords = scenarioWords.filter(w => planScenarioWords.includes(w));
    const score = sharedWords.length;

    if (score > bestScore) {
      bestScore = score;
      bestMatch = plan;
    }
  }

  // Only return fuzzy match if at least one meaningful word overlaps
  return bestScore > 0 ? bestMatch : null;
}

// ── Deduplicate ───────────────────────────────────────────────────────────────
// Migrates any old-format entries (keyed by user input) to canonical keys.
// Removes duplicates — keeps the most recently saved entry per module+scenario.

export function deduplicateMemory() {
  const memory = load();
  const canonical = {};

  for (const [, plan] of Object.entries(memory)) {
    const key = canonicalKey(plan);
    if (!key) continue;

    const existing = canonical[key];
    if (!existing || (plan.savedAt && (!existing.savedAt || plan.savedAt > existing.savedAt))) {
      canonical[key] = plan;
    }
  }

  const before = Object.keys(memory).length;
  const after  = Object.keys(canonical).length;
  save(canonical);

  return { before, after, removed: before - after };
}

// ── List ──────────────────────────────────────────────────────────────────────
// Returns all stored plans as a flat array with their keys.

export function listMemory() {
  const memory = load();
  return Object.entries(memory).map(([key, plan]) => ({
    key,
    module:   plan.module,
    scenario: plan.scenario,
    steps:    plan.steps?.length || 0,
    savedAt:  plan.savedAt || null,
  }));
}