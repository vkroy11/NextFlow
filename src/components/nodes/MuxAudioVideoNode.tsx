"use client";

import { useState } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import { ExternalLink, Loader2, Music2, Video as VideoIcon } from "lucide-react";
import { NodeShell } from "./NodeShell";
import { useWorkflowStore } from "@/store/useWorkflowStore";
import { colorForHandle } from "@/lib/handleColors";
import { isHandleConnected, resolveConnectedValue } from "@/lib/connectedValues";
import { useWorkflowRun } from "../canvas/RunContext";
import { MediaModal } from "./MediaModal";

type Data = {
  outputUrl?: string | null;
};

function pickUrl(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "url" in v) return (v as { url: string }).url;
  return null;
}

export function MuxAudioVideoNode({ id, data, selected }: NodeProps<Data>) {
  const nodes = useWorkflowStore((s) => s.nodes);
  const edges = useWorkflowStore((s) => s.edges);
  const { triggerRun } = useWorkflowRun();
  const runStatus = useWorkflowStore((s) => s.runStatus[id]);
  const [modalOpen, setModalOpen] = useState(false);

  const videoConnected = isHandleConnected(edges, id, "video-input");
  const audioConnected = isHandleConnected(edges, id, "audio-input");

  const upstreamVideo = pickUrl(resolveConnectedValue(nodes, edges, id, "video-input"));
  const upstreamAudio = pickUrl(resolveConnectedValue(nodes, edges, id, "audio-input"));

  const isRunning = runStatus === "running";

  return (
    <>
      <NodeShell
        id={id}
        title="Add Audio to Video"
        tooltip="Mux an audio track onto a video using FFmpeg. Connect a video output to the video input and an audio source (TTS, upload, request inputs) to the audio input."
        selected={selected}
        onRun={() => triggerRun("SINGLE", [id])}
        headerLeft={<Music2 className="h-3.5 w-3.5 shrink-0 text-amber-500" />}
      >
        <div className="space-y-4">
          {/* Video input (required) */}
          <div className="relative">
            <Handle
              id="video-input"
              type="target"
              position={Position.Left}
              className="!h-3.5 !w-3.5 !rounded-full !border-2"
              style={{
                left: -22,
                top: "50%",
                transform: "translateY(-50%)",
                background: colorForHandle("video"),
                borderColor: colorForHandle("video"),
                boxShadow: `${colorForHandle("video")}50 0 0 8px`,
              }}
            />
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs font-medium text-gray-900">
                Video <span className="text-red-500">*</span>
              </span>
              {videoConnected && (
                <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-indigo-700">
                  Linked
                </span>
              )}
            </div>
            <div className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-gray-200 bg-[#FAFAFA] px-3 py-2 text-[12px] font-medium text-gray-500">
              <VideoIcon className="h-3.5 w-3.5" />
              {upstreamVideo ? "Connected" : "Connect a video output"}
            </div>
          </div>

          {/* Audio input (required) */}
          <div className="relative">
            <Handle
              id="audio-input"
              type="target"
              position={Position.Left}
              className="!h-3.5 !w-3.5 !rounded-full !border-2"
              style={{
                left: -22,
                top: "50%",
                transform: "translateY(-50%)",
                background: colorForHandle("audio"),
                borderColor: colorForHandle("audio"),
                boxShadow: `${colorForHandle("audio")}50 0 0 8px`,
              }}
            />
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs font-medium text-gray-900">
                Audio <span className="text-red-500">*</span>
              </span>
              {audioConnected && (
                <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-amber-700">
                  Linked
                </span>
              )}
            </div>
            <div className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-gray-200 bg-[#FAFAFA] px-3 py-2 text-[12px] font-medium text-gray-500">
              <Music2 className="h-3.5 w-3.5" />
              {upstreamAudio ? "Connected" : "Connect an audio output"}
            </div>
          </div>

          {(!videoConnected || !audioConnected) && (
            <p className="text-[10px] text-red-500">Both video and audio inputs are required</p>
          )}

          {/* Output */}
          <div className="relative">
            <span className="mb-1.5 block text-xs font-medium text-gray-900">Output Video</span>
            <Handle
              id="video-output"
              type="source"
              position={Position.Right}
              className="!h-3.5 !w-3.5 !rounded-full !border-2"
              style={{
                right: -22,
                top: "50%",
                transform: "translateY(-50%)",
                background: colorForHandle("video"),
                borderColor: colorForHandle("video"),
                boxShadow: `${colorForHandle("video")}50 0 0 8px`,
              }}
            />
            {isRunning ? (
              <div className="flex h-16 items-center justify-center gap-2 rounded-lg border border-gray-100 bg-[#FAFAFA] text-[12px] text-amber-500">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Muxing audio…
              </div>
            ) : data?.outputUrl ? (
              <div className="overflow-hidden rounded-lg border border-amber-200 bg-amber-50">
                <video
                  src={data.outputUrl}
                  className="nodrag block max-h-40 w-full cursor-pointer object-contain"
                  onClick={() => setModalOpen(true)}
                  muted
                  playsInline
                />
                <div className="flex items-center gap-1 border-t border-amber-100 px-2 py-1.5">
                  <button
                    onClick={() => setModalOpen(true)}
                    className="nodrag flex flex-1 items-center gap-1.5 text-[11px] font-medium text-amber-700 hover:text-amber-900"
                  >
                    <ExternalLink className="h-3 w-3" />
                    View &amp; Download
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex h-16 items-center justify-center rounded-lg border border-gray-100 bg-[#FAFAFA] text-[12px] text-gray-400">
                No output yet
              </div>
            )}
          </div>
        </div>
      </NodeShell>
      {modalOpen && data?.outputUrl && (
        <MediaModal url={data.outputUrl} type="video" onClose={() => setModalOpen(false)} />
      )}
    </>
  );
}
