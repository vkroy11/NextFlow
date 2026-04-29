"use client";

import { useRef, useState } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useReactFlow,
  type EdgeProps,
} from "reactflow";
import { X } from "lucide-react";

export function RemovableEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  selected,
}: EdgeProps) {
  const { setEdges } = useReactFlow();
  const [hovered, setHovered] = useState(false);
  const leaveTimer = useRef<number | null>(null);

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const enter = () => {
    if (leaveTimer.current !== null) {
      window.clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
    setHovered(true);
  };
  const leave = () => {
    if (leaveTimer.current !== null) window.clearTimeout(leaveTimer.current);
    leaveTimer.current = window.setTimeout(() => {
      setHovered(false);
      leaveTimer.current = null;
    }, 80);
  };

  const visible = hovered || selected;

  return (
    <g onMouseEnter={enter} onMouseLeave={leave}>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={style} />
      <EdgeLabelRenderer>
        <div
          onMouseEnter={enter}
          onMouseLeave={leave}
          className="nodrag nopan"
          style={{
            position: "absolute",
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: "all",
            opacity: visible ? 1 : 0,
            transition: "opacity 100ms ease",
          }}
        >
          <button
            type="button"
            title="Remove connection"
            onClick={(e) => {
              e.stopPropagation();
              setEdges((es) => es.filter((edge) => edge.id !== id));
            }}
            className="flex h-5 w-5 items-center justify-center rounded-full border border-gray-300 bg-white text-gray-500 shadow-md transition-colors hover:border-red-300 hover:bg-red-50 hover:text-red-500"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </EdgeLabelRenderer>
    </g>
  );
}
