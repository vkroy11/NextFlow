import { GoogleGenAI } from "@google/genai";

let _client: GoogleGenAI | null = null;

export function googleAI(): GoogleGenAI {
  if (_client) return _client;
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_GENERATIVE_AI_API_KEY missing in env");
  _client = new GoogleGenAI({ apiKey });
  return _client;
}
