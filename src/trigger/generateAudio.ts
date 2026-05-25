import { googleAI } from "@/lib/googleai";
import { uploadBufferToTransloadit } from "@/lib/transloadit";
import { prisma } from "@/lib/prisma";
import { rethrowClassified } from "@/lib/triggerErrors";
import type { Prisma } from "@prisma/client";

export type GenerateAudioPayload = {
  workflowRunId: string;
  nodeRunId: string;
  nodeId: string;
  /** The script to read aloud. */
  prompt: string;
  /** Gemini TTS preset voice name (e.g. "Kore", "Aoede", "Puck"). */
  voiceName: string;
  /**
   * Optional accent / style steering. Prepended to the prompt as a stage
   * direction (Gemini TTS respects natural-language instructions).
   */
  accent?: string;
  /** Defaults to "gemini-2.5-flash-preview-tts". */
  model?: string;
};

export type GenerateAudioOutput = { url: string };

/**
 * Gemini TTS returns raw 24kHz mono 16-bit PCM as base64 in `inlineData.data`.
 * We wrap it in a minimal WAV (RIFF) header so it plays in any browser.
 */
function pcmToWav(pcm: Buffer, sampleRate = 24000, channels = 1, bitsPerSample = 16): Buffer {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcm.length;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);              // Subchunk1Size (16 for PCM)
  header.writeUInt16LE(1, 20);               // AudioFormat (1 = PCM)
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}

export async function runGenerateAudio(
  payload: GenerateAudioPayload,
): Promise<GenerateAudioOutput> {
  const existing = await prisma.nodeRun.findUnique({
    where: { id: payload.nodeRunId },
    select: { status: true, output: true },
  });
  if (existing?.status === "SUCCESS" && existing.output) {
    const out = existing.output as { url?: string };
    if (typeof out.url === "string") return { url: out.url };
  }

  const startedAt = new Date();
  const inputRecord: Record<string, unknown> = {
    prompt: payload.prompt,
    voiceName: payload.voiceName,
  };
  if (payload.accent) inputRecord.accent = payload.accent;

  await prisma.nodeRun.update({
    where: { id: payload.nodeRunId },
    data: { startedAt, input: inputRecord as Prisma.InputJsonValue },
  });

  try {
    if (!payload.prompt.trim()) {
      throw new Error("generateAudio: prompt is required");
    }

    const ai = googleAI();
    const model = payload.model ?? "gemini-2.5-flash-preview-tts";

    // Stage direction: prepended so Gemini TTS shapes pronunciation/accent.
    const fullText = payload.accent
      ? `Speak with a ${payload.accent} accent: ${payload.prompt}`
      : payload.prompt;

    const response = await ai.models.generateContent({
      model,
      contents: [{ parts: [{ text: fullText }] }],
      config: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: payload.voiceName },
          },
        },
      },
    });

    let audioB64: string | null = null;
    for (const candidate of response.candidates ?? []) {
      for (const part of candidate.content?.parts ?? []) {
        if (part.inlineData?.data && part.inlineData?.mimeType?.startsWith("audio/")) {
          audioB64 = part.inlineData.data;
          break;
        }
      }
      if (audioB64) break;
    }
    if (!audioB64) {
      throw new Error("Gemini TTS returned no audio in response");
    }

    const pcm = Buffer.from(audioB64, "base64");
    const wav = pcmToWav(pcm);
    const { url } = await uploadBufferToTransloadit(wav, "tts.wav", "audio/wav");

    const finishedAt = new Date();
    await prisma.nodeRun.update({
      where: { id: payload.nodeRunId },
      data: {
        status: "SUCCESS",
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        output: { url },
      },
    });
    return { url };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.nodeRun.update({
      where: { id: payload.nodeRunId },
      data: { status: "FAILED", finishedAt: new Date(), error: message },
    });
    rethrowClassified(err);
  }
}
