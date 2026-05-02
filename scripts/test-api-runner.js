import { run } from './runners/api-runner.js';

const baseUrl = process.env.BASE_URL || 'http://localhost:4001';
const scenario = {
  id: 'api_contract',
  name: 'API contract smoke',
  module: 'dataapp-api',
  description: 'Run the DataApp API contract and validation checks.',
};

const result = await run(scenario, {
  baseUrl,
  onLog: (text, level = 'info') => console.log(`[${level}] ${text}`),
  onStep: (index, step, status) => {
    if (status === 'running') console.log(`[step ${index + 1}] ${step.target || step.action}`);
  },
});

console.log(JSON.stringify({
  status: result.status,
  summary: result.summary,
}, null, 2));

process.exit(result.status === 'pass' ? 0 : 1);
