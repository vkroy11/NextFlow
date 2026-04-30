"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Tiny copy-to-clipboard button used in node result panels (Response cards,
 * Gemini response box). Shows a checkmark for ~1.5s after a successful
 * write. Disabled (greyed) when there's nothing to copy. The native `title`
 * attribute carries the hover hint — keeps the visual minimal and works on
 * touch / assistive tech.
 */
export function CopyButton({
  text,
  label = "Copy response",
  size = 14,
  className,
}: {
  text: string | null | undefined;
  label?: string;
  size?: number;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const disabled = !text;

  async function handleClick(e: React.MouseEvent) {
    // Stop the click bubbling up to ancestor nodes (NodeShell handles
    // selection on click, edge-mouse handlers, etc.) so copying a result
    // doesn't accidentally re-select the node or close a popover.
    e.stopPropagation();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard write can fail under iframe / permissions-policy
      // restrictions. Silently swallow — the user will notice nothing
      // happened and try again, no toast spam.
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      title={disabled ? "Nothing to copy" : copied ? "Copied!" : label}
      aria-label={label}
      className={cn(
        "nodrag rounded p-1 transition-colors",
        disabled
          ? "cursor-not-allowed text-gray-300"
          : copied
            ? "text-green-600"
            : "text-gray-400 hover:bg-gray-100 hover:text-gray-600",
        className,
      )}
    >
      {copied ? <Check size={size} /> : <Copy size={size} />}
    </button>
  );
}
