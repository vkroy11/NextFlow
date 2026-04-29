"use client";

import { type NodeProps } from "reactflow";
import { X } from "lucide-react";
import { useWorkflowStore } from "@/store/useWorkflowStore";
import { cn } from "@/lib/utils";

type Color = "yellow" | "blue" | "green" | "pink" | "purple" | "orange";

type Data = { text?: string; color?: Color };

const COLORS: Color[] = ["yellow", "blue", "green", "pink", "purple", "orange"];

const NOTE_BG: Record<Color, string> = {
  yellow: "bg-[#FEF6C7]",
  blue: "bg-[#DCEAFE]",
  green: "bg-[#DCFCE7]",
  pink: "bg-[#FCE7F1]",
  purple: "bg-[#EDE9FE]",
  orange: "bg-[#FFEDD5]",
};

const PALETTE_DOT: Record<Color, string> = {
  yellow: "bg-[#FCEC8B]",
  blue: "bg-[#BFDBFE]",
  green: "bg-[#BBF7D0]",
  pink: "bg-[#FBCFE8]",
  purple: "bg-[#DDD6FE]",
  orange: "bg-[#FED7AA]",
};

export function StickyNoteNode({ id, data, selected }: NodeProps<Data>) {
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const removeNode = useWorkflowStore((s) => s.removeNode);
  const color: Color = data?.color ?? "yellow";

  return (
    <div className="group/note relative">
      <div
        className={cn(
          "h-[180px] w-[260px] rounded-2xl p-4 shadow-md transition-all",
          NOTE_BG[color],
          selected ? "ring-2 ring-gray-400" : "ring-1 ring-black/5",
        )}
      >
        <textarea
          value={data?.text ?? ""}
          onChange={(e) => updateNodeData(id, { text: e.target.value })}
          placeholder="Type a note..."
          className="nodrag h-full w-full resize-none bg-transparent text-[14px] leading-relaxed text-gray-800 outline-none placeholder:text-gray-500/70"
        />
      </div>

      <button
        onClick={() => removeNode(id)}
        title="Delete note"
        className="nodrag absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-500 opacity-0 shadow-sm transition-opacity hover:border-red-300 hover:bg-red-50 hover:text-red-500 group-hover/note:opacity-100 group-focus-within/note:opacity-100"
      >
        <X className="h-3 w-3" />
      </button>

      {selected && (
        <div className="nodrag pointer-events-auto absolute left-[calc(100%+12px)] top-0 flex flex-col gap-2.5 rounded-2xl border border-gray-200 bg-white p-2.5 shadow-lg">
          {COLORS.map((c) => (
            <button
              key={c}
              onClick={() => updateNodeData(id, { color: c })}
              title={c}
              className={cn(
                "h-7 w-7 rounded-full transition-transform hover:scale-110",
                PALETTE_DOT[c],
                color === c ? "ring-2 ring-gray-700 ring-offset-2" : "ring-1 ring-black/10",
              )}
            />
          ))}
        </div>
      )}
    </div>
  );
}
