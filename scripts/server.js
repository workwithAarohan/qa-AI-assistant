import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import dotenv from 'dotenv';
dotenv.config();

import { generateSteps, fixSteps } from './agent.js';
import { runSteps } from './executor.js';
import { validatePlan } from './validator.js';
import { getFromMemory, saveToMemory } from './memory.js';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Add a CSP that permits same-origin connections so DevTools can fetch
app.use((req, res, next) => {
  // Permit same-origin connections; allow Tailwind CDN and inline styles/scripts
  const csp = [
    "default-src 'self'",
    "connect-src 'self' ws:",
    "script-src 'self' https://cdn.tailwindcss.com 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
  ].join('; ');

  res.setHeader('Content-Security-Policy', csp);
  next();
});

// Serve DevTools app-specific manifest to avoid 404/CSP console noise
app.get('/.well-known/appspecific/com.chrome.devtools.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  return res.json({
    name: 'com.chrome.devtools',
    description: 'Local DevTools app manifest',
    version: 1,
  });
});

// Serve everything from root — index.html, /public folder, etc.
app.use(express.static(__dirname));

// Explicit route for the test app so it's easy to reference
app.get('/testapp', (req, res) => {
  // `__dirname` is the `scripts` folder; the public folder lives at project root
  res.sendFile(path.join(__dirname, '..', 'public', 'testapp.html'));
});

app.use(express.static('./'));

function generateKey(input) {
  return input.toLowerCase().replace(/\s+/g, '_');
}

function send(ws, type, data) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type, data }));
  }
}

// Pauses execution until the user sends an answer
function waitForAnswer(ws) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('User did not respond in time'));
    }, 120000); // 2 min timeout

    ws.once('message', (raw) => {
      clearTimeout(timeout);
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'answer') {
          resolve(msg.data);
        } else {
          reject(new Error('Expected answer, got: ' + msg.type));
        }
      } catch (err) {
        reject(err);
      }
    });
  });
}

// Asks the user a question mid-execution and waits
async function askUser(ws, question) {
  send(ws, 'question', question);
  const answer = await waitForAnswer(ws);
  send(ws, 'answer_received', answer);
  return answer;
}

wss.on('connection', (ws) => {
  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // Only handle prompt messages here
    // answer messages are handled inside waitForAnswer
    if (msg.type !== 'prompt') return;

    const userInput = msg.data;
    const key = generateKey(userInput);

    try {
      send(ws, 'log', { text: 'Checking memory...', level: 'info' });
      let plan = getFromMemory(key);

      if (plan) {
        send(ws, 'log', { text: 'Memory hit — reusing existing plan', level: 'success' });
      } else {
        send(ws, 'log', { text: 'Calling Gemini to generate plan...', level: 'info' });

        // Ask for missing context before generating if the prompt is vague
        const vague = userInput.split(' ').length < 4;
        let enrichedInput = userInput;

        if (vague) {
          const clarification = await askUser(
            ws,
            'Your instruction is quite short. Can you provide more detail — e.g. which page, what credentials, or what outcome to verify?'
          );
          enrichedInput = `${userInput}. Additional context: ${clarification}`;
        }

        plan = await generateSteps(enrichedInput);
        validatePlan(plan);
        saveToMemory(key, plan);
        send(ws, 'log', { text: 'Plan validated and saved to memory', level: 'success' });
      }

      send(ws, 'plan', plan);

      send(ws, 'log', { text: 'Starting Playwright execution...', level: 'info' });

      let result = await runSteps(plan.steps, (step, status, screenshot) => {
        send(ws, 'step', { step, status });
        if (screenshot) send(ws, 'screenshot', { step, screenshot });
      });

      if (result.status === 'failed') {
        send(ws, 'log', { text: `Step failed: ${result.error}`, level: 'error' });

        // Ask user if they want to attempt auto-heal
        const healChoice = await askUser(
          ws,
          `A step failed: "${result.error}". Should I attempt auto-heal, or do you want to stop?`
        );

        const shouldHeal = healChoice.toLowerCase().includes('heal')
          || healChoice.toLowerCase().includes('yes')
          || healChoice.toLowerCase().includes('try');

        if (shouldHeal) {
          send(ws, 'log', { text: 'Auto-healing — sending error context to Gemini...', level: 'warn' });
          const fixedPlan = await fixSteps(plan, result.error, userInput);
          validatePlan(fixedPlan);

          send(ws, 'log', { text: 'Retrying with healed plan...', level: 'info' });
          result = await runSteps(fixedPlan.steps, (step, status) => {
            send(ws, 'step', { step, status });
          });

          if (result.status === 'success') {
            send(ws, 'log', { text: 'Auto-heal successful — updating memory', level: 'success' });
            saveToMemory(key, fixedPlan);
          } else {
            send(ws, 'log', { text: 'Auto-heal failed', level: 'error' });
          }
        } else {
          send(ws, 'log', { text: 'Execution stopped by user', level: 'warn' });
        }
      } else {
        send(ws, 'log', { text: 'All steps passed', level: 'success' });
        saveToMemory(key, plan);
      }

      send(ws, 'report', result);

    } catch (err) {
      send(ws, 'error', err.message);
    }
  });
});

server.listen(4000, () => {
  console.log('Server running at http://localhost:4000');
});