"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useReactFlow, useStore as useRFStore } from "reactflow";
import {
  ChevronLeft,
  ChevronRight,
  Command,
  LayoutGrid,
  Maximize2,
  Move,
  Redo2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useWorkflowStore } from "@/store/useWorkflowStore";
import { cn } from "@/lib/utils";

type Props = {
  panMode: boolean;
  onTogglePanMode: () => void;
  onAutoArrange: () => void;
  onShowShortcuts: () => void;
};

export function CanvasToolbar({ panMode, onTogglePanMode, onAutoArrange, onShowShortcuts }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const zoom = useRFStore((s) => s.transform[2]);
  const undo = useWorkflowStore((s) => s.undo);
  const redo = useWorkflowStore((s) => s.redo);
  const past = useWorkflowStore((s) => s.past);
  const future = useWorkflowStore((s) => s.future);
  const zoomPct = Math.round((zoom ?? 1) * 100);

  // Mac → ⌘ token, everything else → Ctrl. Keep the keyboard handler in
  // useCanvasShortcuts authoritative; this is only for what we *display*.
  const meta = useMemo(() => {
    if (typeof navigator === "undefined") return "Ctrl";
    return /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
  }, []);

  return (
    <div className="flex items-center gap-0.5 rounded-xl border border-gray-200 bg-white/95 px-1 py-1 shadow-sm backdrop-blur-sm md:gap-1 md:px-2 md:py-1.5">
      <Btn
        
        onClick={() => setCollapsed((v) => !v)}
      >
        {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronLeft className="h-3.5 w-3.5" />}
      </Btn>
      {!collapsed && (
        <>
          <Divider />
          <Btn
            name="Undo"
            description="Step backward through your last edit, move, or connection."
            shortcut={[meta, "Z"]}
            onClick={undo}
            disabled={past.length === 0}
          >
            <Undo2 className="h-3.5 w-3.5" />
          </Btn>
          <Btn
            name="Redo"
            description="Reapply an action you just undid."
            shortcut={[meta, "Shift", "Z"]}
            onClick={redo}
            disabled={future.length === 0}
          >
            <Redo2 className="h-3.5 w-3.5" />
          </Btn>
          <Btn
            name="Keyboard Shortcuts"
            description="Open the full list of canvas and node-operation shortcuts."
            onClick={onShowShortcuts}
          >
            <Command className="h-3.5 w-3.5" />
          </Btn>
          <Divider />
          <Btn
            name="Zoom Out"
            description="Make the canvas content smaller — useful for surveying large workflows."
            shortcut={["−"]}
            onClick={() => zoomOut()}
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </Btn>
          <span className="min-w-[36px] text-center text-xs font-medium text-gray-500 md:min-w-[44px]">
            {zoomPct}%
          </span>
          <Btn
            name="Zoom In"
            description="Get a closer look at a specific node or edge."
            shortcut={["+"]}
            onClick={() => zoomIn()}
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </Btn>
          <Divider />
          <Btn
            name="Fit View"
            description="Pan and zoom so every node on the canvas fits in the viewport."
            shortcut={["F"]}
            onClick={() => fitView({ padding: 0.2, duration: 200 })}
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </Btn>
          <Btn
            name="Auto-arrange"
            description="Lay nodes out in a clean left-to-right DAG using their dependency depth."
            shortcut={["Shift", "A"]}
            onClick={onAutoArrange}
            className="hidden md:inline-flex"
          >
            <LayoutGrid className="h-3.5 w-3.5" />
          </Btn>
          <Btn
            name={panMode ? "Switch to Select Mode" : "Switch to Pan Mode"}
            description={
              panMode
                ? "Drag to box-select multiple nodes instead of panning the canvas."
                : "Click and drag to move the canvas instead of selecting nodes."
            }
            shortcut={["S"]}
            onClick={onTogglePanMode}
            active={panMode}
          >
            <Move className="h-3.5 w-3.5" />
          </Btn>
        </>
      )}
    </div>
  );
}

function Btn({
  name,
  description,
  shortcut,
  onClick,
  disabled,
  active,
  children,
  className,
}: {
  name?: string;
  description?: string;
  shortcut?: string[];
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className="group/tt relative">
      <button
        onClick={onClick}
        disabled={disabled}
        // Native title kept as a fallback for touch / when CSS can't show
        // the rich tooltip (assistive tech reads it via accName).
        title={shortcut ? `${name} (${shortcut.join("+")})` : name}
        className={cn(
          "rounded-lg p-2 transition-colors active:scale-95",
          disabled
            ? "cursor-not-allowed text-gray-300"
            : active
              ? "bg-gray-100 text-gray-900 ring-1 ring-gray-200"
              : "text-gray-700 hover:bg-gray-100 hover:text-gray-900",
          className,
        )}
      >
        {children}
      </button>
      {!disabled &&  name && (
        <RichTooltip name={name} description={description} shortcut={shortcut} />
      )}
    </span>
  );
}

function RichTooltip({
  name,
  description,
  shortcut,
}: {
  name: string;
  description?: string;
  shortcut?: string[];
}) {
  return (
    <span
      // Hidden by default; CSS group-hover on the wrapper reveals it. A small
      // delay (`delay-100`) prevents flicker as the cursor sweeps along the
      // toolbar from one button to the next.
      className="pointer-events-none absolute bottom-full left-1/2 z-[9999] mb-2 hidden w-max max-w-[260px] -translate-x-1/2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-left shadow-lg transition-opacity delay-100 group-hover/tt:block"
      role="tooltip"
    >
      <span className="flex items-center justify-between gap-3">
        <span className="text-[12px] font-semibold text-gray-900">{name}</span>
        {shortcut && shortcut.length > 0 && (
          <span className="flex items-center gap-1">
            {shortcut.map((k, i) => (
              <kbd
                key={`${k}-${i}`}
                className="inline-flex h-4 min-w-[16px] items-center justify-center rounded border border-gray-200 bg-gray-50 px-1 text-[10px] font-medium text-gray-700"
              >
                {k}
              </kbd>
            ))}
          </span>
        )}
      </span>
      {description && (
        <span className="mt-1 block text-[11px] leading-relaxed text-gray-500">{description}</span>
      )}
    </span>
  );
}

function Divider() {
  return <div className="mx-0.5 h-5 w-px bg-gray-200" />;
}
