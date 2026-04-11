import fs from "fs";
import { GoogleGenerativeAI } from "@google/generative-ai";

import dotenv from 'dotenv';
dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

function extractJSON(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON found");
  return JSON.parse(match[0]);
}

export async function generateSteps(userInput) {
  const systemPrompt = fs.readFileSync("./prompt.md", "utf-8");

  const fullPrompt = `${systemPrompt}\n\nUser Request:\n${userInput}\n`;

  let response;
  try {
    const result = await model.generateContent(fullPrompt);
    response = await result.response;
  } catch (err) {
    console.log(model);
    if (err && err.message && err.message.includes('API key not valid')) {
      throw new Error('Generative API rejected the key. Verify GEMINI_API_KEY, enable the Generative Language API, and ensure the key has no restrictive referrer/IP restrictions.');
    }
    throw err;
  }

  let text = (await response.text()).replace(/```json|```/g, "").trim();

  try {
    return extractJSON(text);
  } catch (err) {
    console.error("❌ Raw output from model:\n", text);
    throw new Error("Invalid JSON from Gemini: " + err.message);
  }
}