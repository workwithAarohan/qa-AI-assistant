/**
 * app-config.js — Application target configuration
 *
 * SINGLE APP MODE (current/default):
 *   The agent is bound to one specific application.
 *   URL is fixed from .env BASE_URL — users never need to specify it.
 *   All docs in /docs/ describe that one app's modules.
 *   Best for: demos, hackathons, dedicated QA environments.
 *
 * MULTI APP MODE (opt-in):
 *   Set MULTI_APP_MODE=true in .env.
 *   Define apps in APPS config below.
 *   Users say "test the login on staging" or "run regression on prod".
 *   The agent routes to the right base URL automatically.
 *   Best for: teams managing multiple environments or services.
 *
 * RECOMMENDATION for your hackathon:
 *   Keep SINGLE APP MODE. It gives a cleaner UX and sharper demo.
 *   A single focused agent beats a generic multi-app one every time
 *   when judges are evaluating in a short window.
 */

import dotenv from 'dotenv';
dotenv.config();

export const MULTI_APP_MODE = process.env.MULTI_APP_MODE === 'true';

// ── Single-app config (default) ───────────────────────────────────────────────
export const SINGLE_APP = {
  name:    process.env.APP_NAME    || 'TestApp',
  baseUrl: process.env.BASE_URL    || 'http://localhost:4000/testapp',
  docsDir: process.env.DOCS_DIR    || './docs',
};

// ── Multi-app config (opt-in) ─────────────────────────────────────────────────
// Each app can have its own docs directory (or share one).
export const APPS = [
  {
    name:     'TestApp Dev',
    aliases:  ['dev', 'local', 'development'],
    baseUrl:  'http://localhost:4000/testapp',
    docsDir:  './docs',
  },
  {
    name:     'TestApp Staging',
    aliases:  ['staging', 'stage', 'qa'],
    baseUrl:  process.env.STAGING_URL || 'http://staging.testapp.com',
    docsDir:  './docs',
  },
  // Add more apps here as needed:
  // {
  //   name:    'Payments Service',
  //   aliases: ['payments', 'pay', 'stripe'],
  //   baseUrl: 'https://payments.internal.com',
  //   docsDir: './docs/payments',
  // },
];

/**
 * Resolve which app to test based on user input.
 * In single-app mode, always returns SINGLE_APP.
 * In multi-app mode, tries to match aliases from user input.
 */
export function resolveApp(userInput) {
  if (!MULTI_APP_MODE) return SINGLE_APP;

  const lower = userInput.toLowerCase();
  for (const app of APPS) {
    if (app.aliases.some(a => lower.includes(a))) {
      return { name: app.name, baseUrl: app.baseUrl, docsDir: app.docsDir };
    }
  }

  // Default to first app if no match
  return { name: APPS[0].name, baseUrl: APPS[0].baseUrl, docsDir: APPS[0].docsDir };
}