import fs from 'fs';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getRelevantContext } from './context.js';
import dotenv from 'dotenv';
dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

function extractJSON(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON found in response');
  return JSON.parse(match[0]);
}

export async function generateSteps(userInput) {
  const systemPrompt = fs.readFileSync('./prompt.md', 'utf-8');
  const context = getRelevantContext(userInput); // add this

  const fullPrompt = `
${systemPrompt}
${context ? `\nRelevant Documentation:\n${context}\n` : ''}
User Request:
${userInput}
`.trim();

  const result = await model.generateContent(fullPrompt);
  const response = await result.response;
  let text = response.text().replace(/```json|```/g, '').trim();

  try {
    return extractJSON(text);
  } catch (err) {
    console.error('Raw Gemini output:\n', text);
    throw new Error('Invalid JSON from Gemini: ' + err.message);
  }
}

export async function fixSteps(originalPlan, error, userInput = '') {
  const systemPrompt = fs.readFileSync('./prompt.md', 'utf-8');
  const context = getRelevantContext(userInput || originalPlan.scenario || '');

  const fixPrompt = `
${systemPrompt}
${context ? `\nRelevant Documentation:\n${context}\n` : ''}
The previous test plan failed.

Original Plan:
${JSON.stringify(originalPlan, null, 2)}

Error:
${error}

Fix the steps so the test passes.
Return ONLY valid JSON in the same format.
`.trim();

  const result = await model.generateContent(fixPrompt);
  const response = await result.response;
  let text = response.text().replace(/```json|```/g, '').trim();
  return extractJSON(text);
}