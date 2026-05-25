"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlignLeft,
  Check,
  ChevronRight,
  Clock3,
  Crop,
  FileIcon,
  Hash,
  Image as ImageIcon,
  Layers,
  MessageSquare,
  Mic,
  Music2,
  Search,
  Sparkles,
  Video as VideoIcon,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useReactFlow } from "reactflow";
import { useWorkflowStore } from "@/store/useWorkflowStore";
import { cn } from "@/lib/utils";

type ItemDef = {
  id: string;
  label: string;
  icon?: LucideIcon;
  enabled: boolean;
  nodeType?: string;
  defaultData?: Record<string, unknown>;
};

type SubcategoryDef = {
  id: string;
  label: string;
  items: ItemDef[];
};

type CategoryDef = {
  id: string;
  label: string;
  icon: LucideIcon;
  subs: SubcategoryDef[];
};

const CATEGORIES: CategoryDef[] = [
  {
    id: "image",
    label: "Image",
    icon: ImageIcon,
    subs: [
      {
        id: "gen-image",
        label: "Generate Image",
        items: [
          {
            id: "img-gemini-gen",
            label: "Gemini Image Gen",
            icon: Sparkles,
            enabled: true,
            nodeType: "generateImage",
            defaultData: {
              model: "gemini-3-pro-image-preview",
              prompt: "",
              aspectRatio: "1:1",
            },
          },
          { id: "img-dalle-3", label: "DALL-E 3", icon: MessageSquare, enabled: false },
          { id: "img-flux-pro", label: "Flux Pro", icon: MessageSquare, enabled: false },
          { id: "img-stable-3", label: "Stable Diffusion 3", icon: MessageSquare, enabled: false },
        ],
      },
      {
        id: "edit-image",
        label: "Edit Image",
        items: [
          {
            id: "img-gemini-edit",
            label: "Gemini Image Edit",
            icon: Sparkles,
            enabled: true,
            nodeType: "generateImage",
            defaultData: {
              model: "gemini-3-pro-image-preview",
              prompt: "",
              aspectRatio: "1:1",
            },
          },
          { id: "img-inpaint", label: "Inpaint", icon: MessageSquare, enabled: false },
        ],
      },
    ],
  },
  {
    id: "video",
    label: "Video",
    icon: VideoIcon,
    subs: [
      {
        id: "gen-video",
        label: "Generate Video",
        items: [
          {
            id: "vid-veo-3-1",
            label: "Veo 3.1",
            icon: Sparkles,
            enabled: true,
            nodeType: "generateVideo",
            defaultData: {
              model: "veo-3.1-generate-preview",
              prompt: "",
              durationSeconds: 6,
              aspectRatio: "16:9",
            },
          },
          { id: "vid-sora-2", label: "Sora 2", icon: MessageSquare, enabled: false },
          { id: "vid-runway", label: "Runway Gen-3", icon: MessageSquare, enabled: false },
          { id: "vid-kling", label: "Kling 1.6", icon: MessageSquare, enabled: false },
        ],
      },
      {
        id: "enhance-video",
        label: "Enhance Video",
        items: [
          {
            id: "vid-veo-enhance",
            label: "Veo Enhance",
            icon: Sparkles,
            enabled: true,
            nodeType: "enhanceVideo",
            defaultData: { model: "veo-3.1-generate-preview", prompt: "" },
          },
          { id: "vid-topaz", label: "Topaz Video AI", icon: MessageSquare, enabled: false },
        ],
      },
      {
        id: "extend-video",
        label: "Extend Video",
        items: [
          {
            id: "vid-veo-extend",
            label: "Veo Extend",
            icon: Sparkles,
            enabled: true,
            nodeType: "extendVideo",
            defaultData: {
              model: "veo-3.1-generate-preview",
              prompt: "",
              durationSeconds: 6,
              aspectRatio: "16:9",
            },
          },
        ],
      },
    ],
  },
  {
    id: "audio",
    label: "Audio",
    icon: Mic,
    subs: [
      {
        id: "gen-audio",
        label: "Generate Audio",
        items: [
          { id: "aud-elevenlabs", label: "ElevenLabs v3", icon: MessageSquare, enabled: false },
          { id: "aud-suno", label: "Suno v4", icon: MessageSquare, enabled: false },
        ],
      },
    ],
  },
  {
    id: "others",
    label: "Others",
    icon: Layers,
    subs: [
      {
        id: "oth-input",
        label: "Input",
        items: [
          {
            id: "in-text",
            label: "Text",
            icon: AlignLeft,
            enabled: true,
            nodeType: "input",
            defaultData: { fieldType: "text", value: "" },
          },
          {
            id: "in-number",
            label: "Number",
            icon: Hash,
            enabled: true,
            nodeType: "input",
            defaultData: { fieldType: "number", value: 0 },
          },
          {
            id: "in-boolean",
            label: "Boolean",
            icon: Check,
            enabled: true,
            nodeType: "input",
            defaultData: { fieldType: "boolean", value: false },
          },
          {
            id: "in-image",
            label: "Image",
            icon: ImageIcon,
            enabled: true,
            nodeType: "input",
            defaultData: { fieldType: "image", value: null },
          },
          {
            id: "in-audio",
            label: "Audio",
            icon: Music2,
            enabled: true,
            nodeType: "input",
            defaultData: { fieldType: "audio", value: null },
          },
          {
            id: "in-video",
            label: "Video",
            icon: VideoIcon,
            enabled: true,
            nodeType: "input",
            defaultData: { fieldType: "video", value: null },
          },
          {
            id: "in-file",
            label: "File",
            icon: FileIcon,
            enabled: true,
            nodeType: "input",
            defaultData: { fieldType: "file", value: null },
          },
        ],
      },
      {
        id: "oth-utility",
        label: "Utility",
        items: [
          {
            id: "util-crop",
            label: "Crop Image",
            icon: Crop,
            enabled: true,
            nodeType: "cropImage",
            defaultData: { x: 0, y: 0, w: 100, h: 100 },
          },
          { id: "util-resize", label: "Resize Image", icon: MessageSquare, enabled: false },
          { id: "util-format", label: "Format Convert", icon: MessageSquare, enabled: false },
        ],
      },
      {
        id: "oth-llm",
        label: "LLM Call",
        items: [
          { id: "llm-gpt-nano", label: "GPT 5.4 Nano", icon: MessageSquare, enabled: false },
          { id: "llm-gpt-mini", label: "GPT 5.4 Mini", icon: MessageSquare, enabled: false },
          { id: "llm-gpt", label: "GPT 5.4", icon: MessageSquare, enabled: false },
          {
            id: "llm-gemini-3-1-pro",
            label: "Gemini 3.1 Pro",
            icon: Sparkles,
            enabled: true,
            nodeType: "gemini",
            defaultData: { model: "gemini-3.1-pro-preview", prompt: "", temperature: 0.7 },
          },
          {
            id: "llm-gemini-3-flash",
            label: "Gemini 3 Flash",
            icon: Sparkles,
            enabled: true,
            nodeType: "gemini",
            defaultData: { model: "gemini-3-flash-preview", prompt: "", temperature: 0.7 },
          },
          {
            id: "llm-gemini-3-1-flash-lite",
            label: "Gemini 3.1 Flash Lite",
            icon: Sparkles,
            enabled: true,
            nodeType: "gemini",
            defaultData: { model: "gemini-3.1-flash-lite-preview", prompt: "", temperature: 0.7 },
          },
          {
            id: "llm-gemini-2-5-pro",
            label: "Gemini 2.5 Pro",
            icon: Sparkles,
            enabled: true,
            nodeType: "gemini",
            defaultData: { model: "gemini-2.5-pro", prompt: "", temperature: 0.7 },
          },
          {
            id: "llm-gemini-2-5-flash",
            label: "Gemini 2.5 Flash",
            icon: Sparkles,
            enabled: true,
            nodeType: "gemini",
            defaultData: { model: "gemini-2.5-flash", prompt: "", temperature: 0.7 },
          },
          { id: "llm-claude-sonnet", label: "Claude Sonnet 4.6", icon: MessageSquare, enabled: false },
          { id: "llm-claude-opus", label: "Claude Opus 4.6", icon: MessageSquare, enabled: false },
          { id: "llm-deepseek", label: "DeepSeek V3.2", icon: MessageSquare, enabled: false },
          { id: "llm-grok", label: "Grok 4.1 Fast", icon: MessageSquare, enabled: false },
        ],
      },
    ],
  },
];

// Flat lookup for resolving Recent ids and search results.
const ALL_ITEMS: Array<{ item: ItemDef; catLabel: string; subLabel: string }> = CATEGORIES.flatMap((c) =>
  c.subs.flatMap((s) => s.items.map((item) => ({ item, catLabel: c.label, subLabel: s.label }))),
);

const RECENT_LIMIT = 5;
const recentKey = (workflowId: string) => `nf-recent-${workflowId}`;

export type NodePickerProps = {
  renderTrigger?: (
    open: boolean,
    toggle: () => void,
    btnRef: React.RefObject<HTMLButtonElement | null>,
  ) => ReactNode;
};

export function NodePicker({ renderTrigger }: NodePickerProps = {}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeSub, setActiveSub] = useState<{ catId: string; subId: string } | null>(null);
  const [recentIds, setRecentIds] = useState<string[]>([]);
  // Last def is kept around so the right panel can render content while it
  // fades out — clearing activeSub immediately would otherwise blank it.
  const [stickySubDef, setStickySubDef] = useState<SubcategoryDef | null>(null);
  // Vertical offset of the hovered subcategory button measured from the top
  // of the popover container. Drives the right panel's `top` so it slides
  // to align with the hovered row.
  const [hoverTop, setHoverTop] = useState(0);
  const popoverRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const addNode = useWorkflowStore((s) => s.addNode);
  const workflowId = useWorkflowStore((s) => s.workflowId);
  const reactFlow = useReactFlow();

  const loadRecents = useCallback(() => {
    if (!workflowId) {
      setRecentIds([]);
      return;
    }
    try {
      const raw = localStorage.getItem(recentKey(workflowId));
      setRecentIds(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      setRecentIds([]);
    }
  }, [workflowId]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!open) return;
      const target = e.target as Node;
      if (popoverRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return ALL_ITEMS.filter(({ item }) => item.label.toLowerCase().includes(q));
  }, [query]);

  const recentEntries = useMemo(() => {
    return recentIds
      .map((rid) => ALL_ITEMS.find((entry) => entry.item.id === rid))
      .filter((e): e is { item: ItemDef; catLabel: string; subLabel: string } => Boolean(e));
  }, [recentIds]);

  const closePopover = () => {
    setOpen(false);
    setQuery("");
    setActiveSub(null);
    setStickySubDef(null);
  };

  const handleSubHover = (
    cat: CategoryDef,
    sub: SubcategoryDef,
    e: React.SyntheticEvent<HTMLButtonElement>,
  ) => {
    setActiveSub({ catId: cat.id, subId: sub.id });
    setStickySubDef(sub);
    if (popoverRef.current) {
      const popRect = popoverRef.current.getBoundingClientRect();
      const btnRect = e.currentTarget.getBoundingClientRect();
      // Top of the hovered button measured from the popover's top edge.
      // Sub panel uses this as its `top`, with `bottom: 0` anchored to the
      // popover's bottom — that gives a shared baseline + the sub starts
      // exactly at the row the cursor is on.
      setHoverTop(Math.max(0, btnRect.top - popRect.top));
    }
  };

  const pushRecent = (itemId: string) => {
    if (!workflowId) return;
    setRecentIds((prev) => {
      const next = [itemId, ...prev.filter((id) => id !== itemId)].slice(0, RECENT_LIMIT);
      try {
        localStorage.setItem(recentKey(workflowId), JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const handlePick = (item: ItemDef) => {
    if (!item.enabled || !item.nodeType) return;
    const center = reactFlow.screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2 - 60,
    });
    const uid = `${item.nodeType}-${crypto.randomUUID().slice(0, 8)}`;
    addNode({
      id: uid,
      type: item.nodeType,
      position: { x: center.x - 160, y: center.y - 80 },
      data: item.defaultData ?? {},
    });
    pushRecent(item.id);
    closePopover();
  };

  const toggle = () =>
    setOpen((v) => {
      const next = !v;
      if (next) loadRecents();
      return next;
    });

  const popover = open ? (
    // Fixed-width wrapper: the left panel always sits at the same x — the
    // right panel is rendered absolutely next to it and never widens this
    // container, so the centered group can no longer shift when the sub opens.
    <div
      ref={popoverRef}
      onMouseLeave={() => setActiveSub(null)}
      className="absolute bottom-full left-1/2 mb-3 w-[280px] -translate-x-1/2"
    >
      {/* LEFT PANEL */}
      <div
        className="relative w-full overflow-hidden rounded-2xl border border-gray-200 bg-white/95 shadow-2xl backdrop-blur"
      >
        <div className="p-2.5">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
              <input
                autoFocus
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  if (e.target.value) setActiveSub(null);
                }}
                placeholder="Search nodes or models..."
                className="w-full rounded-xl border border-transparent bg-transparent py-2 pl-10 pr-3 text-sm text-gray-900 outline-none placeholder:text-gray-400"
              />
            </div>
            <button
              type="button"
              onClick={closePopover}
              title="Close"
              className="shrink-0 rounded-lg p-2 text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="h-[370px] overflow-y-auto px-2 pb-2">
          {searchResults ? (
            <div className="pt-1">
              <div className="px-2 py-1 text-[12px] text-gray-500">Results</div>
              <div className="flex flex-col gap-0">
                {searchResults.length === 0 && (
                  <div className="px-2.5 py-3 text-[12px] text-gray-400">No matches</div>
                )}
                {searchResults.map((r) => {
                  const Icon = r.item.icon ?? MessageSquare;
                  return (
                    <button
                      key={r.item.id}
                      onClick={() => handlePick(r.item)}
                      disabled={!r.item.enabled}
                      className={cn(
                        "flex select-none items-start gap-3 rounded-lg px-2.5 py-2 text-left transition-colors",
                        r.item.enabled ? "hover:bg-gray-50" : "cursor-not-allowed opacity-50",
                      )}
                    >
                      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-gray-700" />
                      <div className="min-w-0 flex-1">
                        <div className="text-[14px] font-medium leading-tight text-gray-900">
                          {r.item.label}
                        </div>
                        <div className="mt-0.5 text-[11px] text-gray-500">
                          {r.catLabel} <span className="text-gray-300">•</span> {r.subLabel}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <>
              {recentEntries.length > 0 && (
                <div className="pb-1" onMouseEnter={() => setActiveSub(null)}>
                  <div className="flex items-center gap-2 px-2 py-0.5 text-[11px] text-gray-500">
                    <Clock3 className="h-3.5 w-3.5" />
                    Recent
                  </div>
                  <div className="space-y-0">
                    {recentEntries.map(({ item }) => {
                      const Icon = item.icon ?? MessageSquare;
                      return (
                        <button
                          key={item.id}
                          onClick={() => handlePick(item)}
                          disabled={!item.enabled}
                          className={cn(
                            "flex w-full select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors",
                            item.enabled ? "hover:bg-gray-50" : "cursor-not-allowed opacity-50",
                          )}
                        >
                          <Icon className="h-4 w-4 shrink-0 text-gray-700" />
                          <span className="truncate text-[13px] text-gray-700">{item.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {CATEGORIES.map((cat) => {
                const CatIcon = cat.icon;
                return (
                  <div key={cat.id} className="pt-1">
                    <div className="pt-1.5">
                      <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-gray-500">
                        <CatIcon className="h-3.5 w-3.5" />
                        {cat.label}
                      </div>
                      <div className="flex flex-col gap-0">
                        {cat.subs.map((sub) => {
                          const isActive = activeSub?.catId === cat.id && activeSub.subId === sub.id;
                          return (
                            <button
                              key={sub.id}
                              onMouseEnter={(e) => handleSubHover(cat, sub, e)}
                              onFocus={(e) => handleSubHover(cat, sub, e)}
                              className={cn(
                                "flex select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-gray-50",
                                isActive && "bg-gray-100",
                              )}
                            >
                              <span className="min-w-0 flex-1 text-[13px] leading-snug text-gray-700">
                                {sub.label}
                              </span>
                              <ChevronRight className="h-4 w-4 shrink-0 text-gray-400" />
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>

      {/* RIGHT PANEL — absolutely positioned beside the left panel.
          - Always mounted while the popover is open (so opacity can fade).
          - `top: hoverTop` + `bottom: 0` means the sub starts at the row the
            cursor is on and shares its bottom edge with the left panel.
          - transition on top + opacity gives a smooth slide between rows. */}
      {!searchResults && stickySubDef && (
        <div
          className={cn(
            "absolute left-60 -translate-x-1/2 ml-2 w-[280px] overflow-hidden rounded-2xl border border-gray-200 bg-white/95 shadow-2xl backdrop-blur",
            "transition-[top,opacity,transform] duration-150 ease-out",
            activeSub
              ? "pointer-events-auto translate-x-0 opacity-100"
              : "pointer-events-none -translate-x-1 opacity-0",
          )}
          style={{ top: hoverTop/2, bottom: 0, }}
        >
          <div className="border-b border-gray-100 px-4 py-3 text-[13px] font-medium text-gray-700">
            {stickySubDef.label}
          </div>
          <div className="overflow-y-auto p-1.5" style={{ maxHeight: "calc(100% - 44px)" }}>
            {stickySubDef.items.length === 0 && (
              <div className="px-2.5 py-3 text-[12px] text-gray-400">No items</div>
            )}
            {stickySubDef.items.map((item) => {
              const Icon = item.icon ?? MessageSquare;
              return (
                <button
                  key={item.id}
                  onClick={() => handlePick(item)}
                  disabled={!item.enabled}
                  className={cn(
                    "flex w-full select-none items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[14px] transition-colors",
                    item.enabled ? "text-gray-900 hover:bg-gray-50" : "cursor-not-allowed text-gray-400",
                  )}
                >
                  <Icon
                    className={cn(
                      "h-4 w-4 shrink-0",
                      item.enabled ? "text-gray-600" : "text-gray-400",
                    )}
                  />
                  {item.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  ) : null;

  if (renderTrigger) {
    return (
      <div className="relative">
        {popover}
        {renderTrigger(open, toggle, buttonRef)}
      </div>
    );
  }

  return (
    <div className="pointer-events-auto absolute bottom-6 left-1/2 z-20 -translate-x-1/2">
      {popover}
      <button
        ref={buttonRef}
        onClick={toggle}
        title="Add node"
        aria-label="Add node"
        className={cn(
          "flex h-9 w-9 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-700 shadow-sm transition-colors hover:bg-gray-50",
          open && "bg-gray-100",
        )}
      >
        <span className="block h-4 w-4">+</span>
      </button>
    </div>
  );
}
