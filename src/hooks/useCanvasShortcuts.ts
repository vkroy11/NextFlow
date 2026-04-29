"use client";

import { useEffect } from "react";
import { useReactFlow } from "reactflow";
import { useWorkflowStore } from "@/store/useWorkflowStore";

type Options = {
  onToggleSelect?: () => void;
  onAutoArrange?: () => void;
};

function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (t.isContentEditable) return true;
  return false;
}

export function useCanvasShortcuts({ onToggleSelect, onAutoArrange }: Options = {}) {
  const undo = useWorkflowStore((s) => s.undo);
  const redo = useWorkflowStore((s) => s.redo);
  const selectAll = useWorkflowStore((s) => s.selectAll);
  const deselectAll = useWorkflowStore((s) => s.deselectAll);
  const copySelection = useWorkflowStore((s) => s.copySelection);
  const pasteClipboard = useWorkflowStore((s) => s.pasteClipboard);
  const duplicateSelection = useWorkflowStore((s) => s.duplicateSelection);
  const deleteSelection = useWorkflowStore((s) => s.deleteSelection);
  const { zoomIn, zoomOut, fitView } = useReactFlow();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) {
        // Allow Esc to deselect even when typing
        if (e.key === "Escape") {
          deselectAll();
        }
        return;
      }
      const meta = e.metaKey || e.ctrlKey;
      const shift = e.shiftKey;
      const key = e.key;

      // Undo / Redo
      if (meta && !shift && key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
        return;
      }
      if (meta && shift && key.toLowerCase() === "z") {
        e.preventDefault();
        redo();
        return;
      }
      // Select all / deselect
      if (meta && key.toLowerCase() === "a") {
        e.preventDefault();
        selectAll();
        return;
      }
      if (key === "Escape") {
        deselectAll();
        return;
      }
      // Copy / paste
      if (meta && !shift && key.toLowerCase() === "c") {
        copySelection();
        return;
      }
      if (meta && key.toLowerCase() === "v") {
        e.preventDefault();
        pasteClipboard();
        return;
      }
      // Duplicate / duplicate with edges
      if (meta && shift && key.toLowerCase() === "d") {
        e.preventDefault();
        duplicateSelection(true);
        return;
      }
      if (meta && !shift && key.toLowerCase() === "d") {
        e.preventDefault();
        duplicateSelection(false);
        return;
      }
      // Delete
      if (key === "Delete" || key === "Backspace") {
        e.preventDefault();
        deleteSelection();
        return;
      }
      // Zoom
      if (!meta && (key === "+" || key === "=")) {
        e.preventDefault();
        zoomIn();
        return;
      }
      if (!meta && key === "-") {
        e.preventDefault();
        zoomOut();
        return;
      }
      if (!meta && key.toLowerCase() === "f") {
        e.preventDefault();
        fitView({ padding: 0.2, duration: 200 });
        return;
      }
      if (!meta && shift && key.toLowerCase() === "a") {
        e.preventDefault();
        onAutoArrange?.();
        return;
      }
      if (!meta && !shift && key.toLowerCase() === "s") {
        e.preventDefault();
        onToggleSelect?.();
        return;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [
    undo,
    redo,
    selectAll,
    deselectAll,
    copySelection,
    pasteClipboard,
    duplicateSelection,
    deleteSelection,
    zoomIn,
    zoomOut,
    fitView,
    onToggleSelect,
    onAutoArrange,
  ]);
}
