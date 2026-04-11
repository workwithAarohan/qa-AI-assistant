import fs from "fs";

const MEMORY_FILE = "./memory.json";

function loadMemory() {
  if (!fs.existsSync(MEMORY_FILE)) return {};
  return JSON.parse(fs.readFileSync(MEMORY_FILE));
}

function saveMemory(memory) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
}

export function getFromMemory(key) {
  const memory = loadMemory();
  return memory[key];
}

export function saveToMemory(key, plan) {
  const memory = loadMemory();
  memory[key] = plan;
  saveMemory(memory);
}