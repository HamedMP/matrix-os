"use client";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import type { FileResourceRef } from "@matrix-os/contracts";
import { z } from "zod/v4";
import type { InspectorTool, SideChatClient } from "@matrix-os/ui";
import {
  readLayout,
  createChatTerminal,
  deleteChatTerminal,
  FILES,
  NEW,
  SIDE,
  MAX_TABS,
  type Tab,
  type Session,
} from "./web-chat-inspector-state";

/** Keep a previously opened panel mounted only within this verified Chat scope. */
export function useWebChatInspectorVisibility(identity: string) {
  const [session, setSession] = useState({ identity, open: false, opened: false });
  const setOpen = useCallback((update: boolean | ((open: boolean) => boolean)) => {
    setSession(previous => {
      const current = previous.identity === identity ? previous : { identity, open: false, opened: false };
      const open = typeof update === "function" ? update(current.open) : update;
      return { identity, open, opened: current.opened || open };
    });
  }, [identity]);
  return { open: session.identity === identity && session.open, opened: session.identity === identity && session.opened, setOpen };
}

export interface WebChatInspectorProps {
  active?: boolean;
  chatId: string;
  chatTitle?: string;
  gatewayUrl: string;
  layoutKey: string | null;
  rootWidth: number;
  railWidth: number;
  project?: { id: string; slug: string };
  worktreeId?: string;
  projectLoading?: boolean;
  projectError?: boolean;
  onRetryProject?(): void;
  filePath: string | null;
  fileOpenRequest?: object;
  fileResource?: FileResourceRef;
  onFilePathChange(path: string | null): void;
  terminalSessionIds: readonly string[];
  sideChatClient: SideChatClient;
  onSendToMain(text: string): void;
  onClose(): void;
}
export function useWebChatInspector({
  active = true,
  chatId,
  chatTitle,
  gatewayUrl,
  layoutKey,
  rootWidth,
  railWidth,
  project,
  projectLoading,
  projectError,
  filePath,
  fileOpenRequest,
  onFilePathChange,
  terminalSessionIds,
  sideChatClient,
  onSendToMain,
  onClose,
}: WebChatInspectorProps) {
  const [layout, setLayout] = useState(() => readLayout(layoutKey, terminalSessionIds));
  const [sessions, setSessions] = useState<Session[]>([]);
  const [registryReady, setRegistryReady] = useState(false);
  const [registryVersion, setRegistryVersion] = useState(0);
  const registryMutation = useRef(0);
  const [pending, setPending] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState(false);
  const [closeTarget, setCloseTarget] = useState<Tab | null>(null);
  const [fileExpanded, setFileExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const [panelHeight, setPanelHeight] = useState(600);
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const measure = () => setPanelHeight(panel.clientHeight || 600);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);
  const treeMax = Math.max(0, Math.min(1200, panelHeight - 216));
  const treeMin = Math.min(120, treeMax);
  const treeHeight = Math.max(treeMin, Math.min(treeMax, layout.treeHeight));
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (layoutKey) {
      try {
        localStorage.setItem(layoutKey, JSON.stringify(layout));
      } catch (cause: unknown) {
        console.warn("[chat-inspector] Layout save unavailable:", cause instanceof Error ? cause.name : "UnknownError");
      }
    }
  }, [layoutKey, layout]);
  const signal = () => AbortSignal.any([lifetime.current!.signal, AbortSignal.timeout(10_000)]);
  const bindings = terminalSessionIds.join("\0");
  const commitDiscoveredSessions = useEffectEvent((available: Session[]) => {
    const mounted = layout.tabs.flatMap((tab) => {
      const session = available.find((item) => `terminal:${item.ref}` === tab.id);
      return session ? [session] : [];
    });
    const remaining = MAX_TABS - mounted.length;
    const boundRefs = bindings.split("\0");
    const extras = remaining > 0 ? available.filter((session) =>
      boundRefs.includes(session.ref) && !mounted.some((item) => item.ref === session.ref),
    ).slice(-remaining) : [];
    // Creation trims from the front: evict unmounted candidates before visible tabs.
    setSessions([...extras, ...mounted]);
    setRegistryReady(true);
  });
  useEffect(() => {
    if (!bindings && !layout.tabs.some((tab) => tab.kind === "terminal")) {
      setRegistryReady(true);
      return;
    }
    const controller = new AbortController();
    const mutation = registryMutation.current;
    void fetch(`${gatewayUrl}/api/terminal/workspaces`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("TerminalUnavailable");
        return z
          .object({
            workspaces: z
              .array(
                z.object({
                  id: z.string().max(128),
                  tabs: z
                    .array(
                      z.object({
                        id: z.string().max(128),
                        name: z.string().max(200).optional(),
                        cwd: z.string().max(4096).optional(),
                        status: z.string().max(40).optional(),
                      }),
                    )
                    .max(1000),
                }),
              )
              .max(100),
          })
          .parse(await response.json());
      })
      .then(({ workspaces }) => {
        if (controller.signal.aborted || mutation !== registryMutation.current) return;
        commitDiscoveredSessions(
          workspaces
            .flatMap((workspace) =>
              workspace.tabs.map((tab) => ({
                ref: `${workspace.id}:${tab.id}`,
                name: tab.name ?? "Terminal",
                cwd: tab.cwd ?? "",
                attachable: !tab.status || ["running", "idle", "starting"].includes(tab.status),
              })),
            ),
        );
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          console.warn(
            "[chat-inspector] Terminal discovery failed:",
            cause instanceof Error ? cause.name : "UnknownError",
          );
          setError(true);
        }
      });
    return () => controller.abort();
    // Persisted tabs seed discovery. Creating a tab already has its authoritative response.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gatewayUrl, bindings, registryVersion]);
  const openTab = (tab: Tab) =>
    setLayout((current) => ({
      ...current,
      selected: tab.id,
      tabs: current.tabs.some((item) => item.id === tab.id)
        ? current.tabs.filter((item) => item.kind !== "new")
        : [...current.tabs.filter((item) => item.kind !== "new").slice(-(MAX_TABS - 1)), tab],
    }));
  useEffect(() => {
    if (filePath) {
      setLayout((current) => ({
        ...current,
        selected: "files",
        tabs: current.tabs.some((tab) => tab.kind === "files")
          ? current.tabs.filter((tab) => tab.kind !== "new")
          : [...current.tabs.filter((tab) => tab.kind !== "new"), FILES].slice(-MAX_TABS),
      }));
    }
  }, [filePath, fileOpenRequest]);
  const selected = layout.tabs.find((tab) => tab.id === layout.selected) ?? layout.tabs[0]!;
  const overlay = rootWidth > 0 && rootWidth - railWidth < 600;
  const maxWidth = Math.max(240, Math.min(820, rootWidth - railWidth - 360));
  const width = Math.min(layout.width, maxWidth);
  const removeTab = (id: string) =>
    setLayout((current) => {
      const tabs = current.tabs.filter((tab) => tab.id !== id);
      return {
        ...current,
        tabs: tabs.length ? tabs : [NEW],
        selected: current.selected === id ? (tabs.at(-1)?.id ?? NEW.id) : current.selected,
      };
    });
  const createTerminal = () => {
    if (lock.current) return;
    if (projectLoading || projectError) { setError(true); return; }
    lock.current = true;
    setPending(true);
    setError(false);
    return createChatTerminal(gatewayUrl, chatId, signal(), project?.slug)
      .then((session) => {
        if (lifetime.current!.signal.aborted) return;
        registryMutation.current++;
        setRegistryVersion(registryMutation.current);
        setSessions((current) => [...current.filter((item) => item.ref !== session.ref), session].slice(-MAX_TABS));
        openTab({
          id: `terminal:${session.ref}`,
          kind: "terminal",
          label: session.name,
        });
      })
      .catch((cause: unknown) => {
        if (!lifetime.current!.signal.aborted) {
          console.warn(
            "[chat-inspector] Terminal create failed:",
            cause instanceof Error ? cause.name : "UnknownError",
          );
          setError(true);
        }
      })
      .finally(() => {
        lock.current = false;
        if (!lifetime.current!.signal.aborted) setPending(false);
      });
  };
  const choose = (kind: Exclude<InspectorTool, "new">) => {
    setMenuOpen(false);
    if (kind === "terminal") {
      void createTerminal();
    } else if (kind !== "browser") openTab(kind === "files" ? FILES : SIDE);
  };
  const closeTab = (id: string) => {
    const tab = layout.tabs.find((item) => item.id === id);
    if (!tab) return;
    const session = sessions.find((item) => `terminal:${item.ref}` === id);
    if (tab.kind === "terminal" && (!registryReady || session?.attachable)) {
      setError(false);
      setCloseTarget(tab);
    } else removeTab(id);
  };
  const stopTerminal = () => {
    const target = closeTarget;
    if (!target || lock.current) return;
    lock.current = true;
    setPending(true);
    setError(false);
    return deleteChatTerminal(gatewayUrl, target, signal())
      .then(() => {
        if (lifetime.current!.signal.aborted) return;
        registryMutation.current++;
        setRegistryVersion(registryMutation.current);
        setSessions((current) => current.filter((item) => `terminal:${item.ref}` !== target.id));
        removeTab(target.id);
        setCloseTarget(null);
      })
      .catch((cause: unknown) => {
        if (!lifetime.current!.signal.aborted) {
          console.warn("[chat-inspector] Terminal stop failed:", cause instanceof Error ? cause.name : "UnknownError");
          setError(true);
        }
      })
      .finally(() => {
        lock.current = false;
        if (!lifetime.current!.signal.aborted) setPending(false);
      });
  };
  const shortcut = useEffectEvent((event: KeyboardEvent) => {
    if (
      !active ||
      event.defaultPrevented ||
      event.repeat ||
      (event.target instanceof HTMLElement && event.target.closest("input, textarea, [contenteditable=true]"))
    )
      return;
    const key = event.key.toLowerCase();
    const kind =
      event.metaKey && event.altKey && (key === "s" || event.code === "KeyS")
        ? "side-chat"
        : event.metaKey && !event.altKey && key === "p"
          ? "files"
          : event.ctrlKey && !event.metaKey && key === "`"
            ? "terminal"
            : null;
    if (kind) {
      event.preventDefault();
      choose(kind);
    }
  });
  useEffect(() => {
    if (!active) return;
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [active]);
  const drag = (event: React.PointerEvent<HTMLDivElement>, axis: "width" | "tree") => {
    event.preventDefault();
    const target = event.currentTarget;
    const start = axis === "width" ? event.clientX : event.clientY;
    const initial = axis === "width" ? width : treeHeight;
    target.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => {
      const requested = initial + (axis === "width" ? start - next.clientX : next.clientY - start);
      if (axis === "width" && requested < 192) {
        onClose();
        return;
      }
      setLayout((current) => ({
        ...current,
        ...(axis === "width"
          ? { width: Math.max(240, Math.min(maxWidth, requested)) }
          : {
              treeHeight: Math.max(treeMin, Math.min(treeMax, requested)),
            }),
      }));
    };
    const end = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("pointercancel", end);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end, { once: true });
    target.addEventListener("pointercancel", end, { once: true });
    lifetime.current!.signal.addEventListener("abort", end, { once: true });
  };
  const picker = () => {
    setMenuOpen(false);
    setLayout((current) => ({
      ...current,
      selected: NEW.id,
      tabs: current.tabs.some((tab) => tab.kind === "new") ? current.tabs : [...current.tabs, NEW].slice(-MAX_TABS),
    }));
  };
  return {
    layout,
    setLayout,
    sessions,
    registryReady,
    pending,
    error,
    closeTarget,
    setCloseTarget,
    fileExpanded,
    setFileExpanded,
    menuOpen,
    setMenuOpen,
    panelRef,
    treeHeight,
    treeMin,
    treeMax,
    selected,
    overlay,
    maxWidth,
    width,
    closeTab,
    picker,
    choose,
    openTab,
    createTerminal,
    stopTerminal,
    drag,
  };
}
