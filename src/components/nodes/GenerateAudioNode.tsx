"use client";

import { useState } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import { Loader2, Music2, Volume2 } from "lucide-react";
import { NodeShell } from "./NodeShell";
import { useWorkflowStore } from "@/store/useWorkflowStore";
import { colorForHandle } from "@/lib/handleColors";
import { isHandleConnected, resolveConnectedValue } from "@/lib/connectedValues";
import { useWorkflowRun } from "../canvas/RunContext";
import { cn } from "@/lib/utils";

type Data = {
  prompt?: string;
  voiceName?: string;
  accent?: string;
  outputUrl?: string | null;
};

// Gemini TTS preset voices. Labels in parentheses are vibe descriptors from
// Google's docs — they're language-agnostic but the model respects accent
// instructions in the prompt, which the Accent dropdown controls.
const VOICES = [
  { value: "Aoede", label: "Aoede (breezy female)" },
  { value: "Charon", label: "Charon (informative male)" },
  { value: "Fenrir", label: "Fenrir (excitable male)" },
  { value: "Kore", label: "Kore (firm female)" },
  { value: "Puck", label: "Puck (upbeat male)" },
  { value: "Zephyr", label: "Zephyr (bright female)" },
  { value: "Leda", label: "Leda (youthful female)" },
  { value: "Orus", label: "Orus (mature male)" },
] as const;

const ACCENTS = [
  { value: "", label: "Default (no steering)" },
  { value: "Indian English", label: "Indian English" },
  { value: "American English", label: "American English" },
  { value: "British English", label: "British English" },
  { value: "Australian English", label: "Australian English" },
] as const;

export function GenerateAudioNode({ id, data, selected }: NodeProps<Data>) {
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const nodes = useWorkflowStore((s) => s.nodes);
  const edges = useWorkflowStore((s) => s.edges);
  const { triggerRun } = useWorkflowRun();
  const runStatus = useWorkflowStore((s) => s.runStatus[id]);
  const [modalOpen, setModalOpen] = useState(false);
  void modalOpen;

  const promptConnected = isHandleConnected(edges, id, "prompt");
  const upstreamPrompt = resolveConnectedValue(nodes, edges, id, "prompt");
  const promptValue =
    promptConnected && typeof upstreamPrompt === "string"
      ? upstreamPrompt
      : data?.prompt ?? "";

  const isRunning = runStatus === "running";
  const voice = data?.voiceName ?? "Kore";
  const accent = data?.accent ?? "";

  return (
    <NodeShell
      id={id}
      title="Generate Audio (TTS)"
      tooltip="Gemini text-to-speech. Pick a voice and an optional accent. Output is a WAV audio URL ready to mux onto a video."
      selected={selected}
      onRun={() => triggerRun("SINGLE", [id])}
      headerLeft={<Music2 className="h-3.5 w-3.5 shrink-0 text-amber-500" />}
    >
      <div className="space-y-4">
        {/* Prompt (script) */}
        <div className="relative">
          <Handle
            id="prompt"
            type="target"
            position={Position.Left}
            className="!h-3.5 !w-3.5 !rounded-full !border-2"
            style={{
              left: -22,
              top: 12,
              transform: "translateY(-50%)",
              background: colorForHandle("prompt"),
              borderColor: colorForHandle("prompt"),
              boxShadow: `${colorForHandle("prompt")}50 0 0 8px`,
            }}
          />
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs font-medium text-gray-900">
              Script <span className="text-red-500">*</span>
            </span>
            {promptConnected && (
              <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-amber-700">
                Linked
              </span>
            )}
          </div>
          <textarea
            value={promptValue}
            disabled={promptConnected}
            onChange={(e) => updateNodeData(id, { prompt: e.target.value })}
            placeholder="What should the voice say..."
            rows={3}
            className={cn(
              "nodrag w-full resize-y rounded-lg border border-gray-200 bg-[#FAFAFA] px-3 py-2 text-[13px] text-gray-800 outline-none focus:border-workflow-accent-400 focus:bg-white",
              promptConnected && "cursor-not-allowed bg-gray-50 text-gray-400",
            )}
          />
        </div>

        {/* Voice */}
        <div>
          <span className="mb-1 block text-xs font-medium text-gray-700">Voice</span>
          <select
            value={voice}
            onChange={(e) => updateNodeData(id, { voiceName: e.target.value })}
            className="nodrag w-full rounded-lg border border-gray-200 bg-[#FAFAFA] px-3 py-1.5 text-[12px] text-gray-800 outline-none focus:border-workflow-accent-400 focus:bg-white"
          >
            {VOICES.map((v) => (
              <option key={v.value} value={v.value}>
                {v.label}
              </option>
            ))}
          </select>
        </div>

        {/* Accent */}
        <div>
          <span className="mb-1 block text-xs font-medium text-gray-700">Accent</span>
          <select
            value={accent}
            onChange={(e) => updateNodeData(id, { accent: e.target.value || undefined })}
            className="nodrag w-full rounded-lg border border-gray-200 bg-[#FAFAFA] px-3 py-1.5 text-[12px] text-gray-800 outline-none focus:border-workflow-accent-400 focus:bg-white"
          >
            {ACCENTS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </div>

        {/* Output */}
        <div className="relative">
          <span className="mb-1.5 block text-xs font-medium text-gray-900">Audio</span>
          <Handle
            id="audio-output"
            type="source"
            position={Position.Right}
            className="!h-3.5 !w-3.5 !rounded-full !border-2"
            style={{
              right: -22,
              top: "50%",
              transform: "translateY(-50%)",
              background: colorForHandle("audio"),
              borderColor: colorForHandle("audio"),
              boxShadow: `${colorForHandle("audio")}50 0 0 8px`,
            }}
          />
          {isRunning ? (
            <div className="flex h-16 items-center justify-center gap-2 rounded-lg border border-gray-100 bg-[#FAFAFA] text-[12px] text-amber-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Synthesising…
            </div>
          ) : data?.outputUrl ? (
            <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-2 py-2">
              <Volume2 className="h-3.5 w-3.5 shrink-0 text-amber-600" />
              <audio
                controls
                src={data.outputUrl}
                className="nodrag h-8 flex-1"
                style={{ minWidth: 0 }}
              />
            </div>
          ) : (
            <div className="flex h-16 items-center justify-center rounded-lg border border-gray-100 bg-[#FAFAFA] text-[12px] text-gray-400">
              No output yet
            </div>
          )}
        </div>
      </div>
    </NodeShell>
  );
}
