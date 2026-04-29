import { GoogleGenerativeAI, type Part } from "@google/generative-ai";

let _client: GoogleGenerativeAI | null = null;

export function gemini() {
  if (_client) return _client;
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_GENERATIVE_AI_API_KEY missing in env");
  _client = new GoogleGenerativeAI(apiKey);
  return _client;
}

export type GeminiCallInput = {
  model: string;
  prompt: string;
  systemPrompt?: string;
  imageUrls?: string[];
  temperature?: number;
};

// Per https://ai.google.dev/gemini-api/docs/models the Gemini 3 family is
// currently published with a `-preview` suffix. Workflows saved before we
// learned that (and imports from the Galaxy.ai catalog) reference the bare
// "gemini-3.1-pro" form which the v1beta endpoint rejects with a 404. Map
// the bare ids to their real preview equivalents so existing workflows run.
const MODEL_ALIASES: Record<string, string> = {
  "gemini-3.1-pro": "gemini-3.1-pro-preview",
  "gemini-3-pro": "gemini-3.1-pro-preview",
  "gemini-3-flash": "gemini-3-flash-preview",
  "gemini-3.1-flash": "gemini-3-flash-preview",
  "gemini-3.1-flash-lite": "gemini-3.1-flash-lite-preview",
};

export async function callGemini(input: GeminiCallInput): Promise<string> {
  const requestedModel = input.model || "gemini-2.5-pro";
  const actualModel = MODEL_ALIASES[requestedModel] ?? requestedModel;
  const model = gemini().getGenerativeModel({
    model: actualModel,
    ...(input.systemPrompt ? { systemInstruction: input.systemPrompt } : {}),
    generationConfig: { temperature: input.temperature ?? 0.7 },
  });

  const parts: Part[] = [{ text: input.prompt }];
  for (const url of input.imageUrls ?? []) {
    if (url.startsWith("data:")) {
      const [meta, data] = url.split(",");
      const mimeMatch = /data:([^;]+);base64/.exec(meta);
      parts.push({ inlineData: { data, mimeType: mimeMatch?.[1] ?? "image/jpeg" } });
    } else {
      const res = await fetch(url);
      const buf = Buffer.from(await res.arrayBuffer());
      parts.push({
        inlineData: { data: buf.toString("base64"), mimeType: res.headers.get("content-type") ?? "image/jpeg" },
      });
    }
  }

  const result = await model.generateContent({ contents: [{ role: "user", parts }] });
  return result.response.text();
}
