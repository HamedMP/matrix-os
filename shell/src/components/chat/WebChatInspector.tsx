"use client";

import { useEffect, useRef, useState } from "react";
import { z } from "zod/v4";
import { SideChatPanel, type SideChatClient } from "@matrix-os/ui";
import { useTheme } from "@/hooks/useTheme";
import { TerminalPane } from "@/components/terminal/TerminalPane";
import { parseTerminalRefKey } from "@/components/terminal/terminal-session-id";
import { ChatFilePanel } from "./ChatFilePanel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";

const FileEntrySchema = z.object({ name: z.string().min(1).max(255), type: z.enum(["file", "directory"]) }).passthrough();
const FileListSchema = z.union([z.object({ entries: z.array(FileEntrySchema) }).passthrough(), z.array(FileEntrySchema)]);
type FileEntry = z.infer<typeof FileEntrySchema>;
type Tab = "files" | "terminal" | "side-chat";
type SavedLayout = { width: number; treeHeight: number; selected: Tab };

function readLayout(key: string | null): SavedLayout {
  if (!key) return { width: 400, treeHeight: 240, selected: "files" };
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as Partial<SavedLayout> | null;
    return { width: typeof value?.width === "number" && Number.isFinite(value.width) ? Math.max(240, Math.min(820, value.width)) : 400,
      treeHeight: typeof value?.treeHeight === "number" && Number.isFinite(value.treeHeight) ? Math.max(120, Math.min(1200, value.treeHeight)) : 240,
      selected: value?.selected === "terminal" || value?.selected === "side-chat" ? value.selected : "files" };
  } catch (error: unknown) {
    console.warn("[chat-inspector] Layout read unavailable:", error instanceof Error ? error.name : "UnknownError");
    return { width: 400, treeHeight: 240, selected: "files" };
  }
}

function FileTree({ gatewayUrl, onOpenFile }: { gatewayUrl: string; onOpenFile(path: string): void }) {
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    void fetch(`${gatewayUrl}/api/files/list?path=${encodeURIComponent(path)}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) })
      .then(async response => { if (!response.ok) throw new Error("FileListUnavailable"); return FileListSchema.parse(await response.json()); })
      .then(data => {
        if (controller.signal.aborted) return;
        const available = Array.isArray(data) ? data : data.entries;
        setEntries(available.slice(0, 1000));
        setTruncated(available.length > 1000);
      })
      .catch((cause: unknown) => { if (!controller.signal.aborted) { console.warn("[chat-inspector] Files unavailable:", cause instanceof Error ? cause.name : "UnknownError"); setError(true); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [gatewayUrl, path]);
  return <div role="tree" aria-label="Chat files" className="min-h-0 flex-1 overflow-y-auto p-2 text-sm">
    <button type="button" className="mb-1 block w-full truncate rounded px-2 py-1 text-left hover:bg-accent" onClick={() => setPath(path.split("/").slice(0, -1).join("/"))}>{path ? `← ${path}` : "Home"}</button>
    {loading && !entries.length ? <p role="status" className="px-2 text-xs">Loading files…</p> : null}
    {error ? <p role="alert" className="px-2 text-xs">Files could not be loaded.</p> : null}
    {truncated ? <p className="px-2 text-xs text-muted-foreground">Showing the first 1,000 files.</p> : null}
    {entries.map(entry => {
      const fullPath = path ? `${path}/${entry.name}` : entry.name;
      return <button key={entry.name} type="button" role="treeitem" aria-label={entry.name} className="block w-full truncate rounded px-2 py-1 text-left hover:bg-accent"
        onClick={() => entry.type === "directory" ? setPath(fullPath) : onOpenFile(fullPath)}>{entry.type === "directory" ? "▸ " : "  "}{entry.name}</button>;
    })}
  </div>;
}

export function WebChatInspector({ chatId, gatewayUrl, layoutKey, rootWidth, railWidth, filePath, onFilePathChange, terminalSessionIds,
  sideChatClient, onSendToMain, onClose }: {
  chatId: string;
  gatewayUrl: string;
  layoutKey: string | null;
  rootWidth: number;
  railWidth: number;
  filePath: string | null;
  onFilePathChange(path: string | null): void;
  terminalSessionIds: readonly string[];
  sideChatClient: SideChatClient;
  onSendToMain(text: string): void;
  onClose(): void;
}) {
  const [layout, setLayout] = useState(() => readLayout(layoutKey));
  const [terminalRef, setTerminalRef] = useState<string | null>(null);
  const [stoppedRef, setStoppedRef] = useState<string | null>(null);
  const [terminalPending, setTerminalPending] = useState(false);
  const [terminalError, setTerminalError] = useState(false);
  const [closeTerminalConfirm, setCloseTerminalConfirm] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const theme = useTheme();
  useEffect(() => { setLayout(readLayout(layoutKey)); }, [layoutKey]);
  useEffect(() => { if (layoutKey) { try { localStorage.setItem(layoutKey, JSON.stringify(layout)); } catch (error: unknown) { console.warn("[chat-inspector] Layout save unavailable:", error instanceof Error ? error.name : "UnknownError"); } } }, [layoutKey, layout]);
  const savedTerminalRefs = terminalSessionIds.join("\0");
  useEffect(() => {
    const controller = new AbortController();
    setTerminalRef(null);
    if (!savedTerminalRefs) return () => controller.abort();
    void fetch(`${gatewayUrl}/api/terminal/workspaces`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) })
      .then(async response => {
        if (!response.ok) throw new Error("TerminalUnavailable");
        return z.object({ workspaces: z.array(z.object({ id: z.string().max(128), tabs: z.array(z.object({ id: z.string().max(128) }).passthrough()).max(10_000) }).passthrough()).max(100) }).parse(await response.json());
      })
      .then(({ workspaces }) => {
        if (controller.signal.aborted) return;
        const live = new Set(workspaces.flatMap(workspace => workspace.tabs.map(tab => `${workspace.id}:${tab.id}`)));
        setTerminalRef(savedTerminalRefs.split("\0").find(ref => ref !== stoppedRef && parseTerminalRefKey(ref) && live.has(ref)) ?? null);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        console.warn("[chat-inspector] Terminal references unavailable:", cause instanceof Error ? cause.name : "UnknownError");
        setTerminalError(true);
      });
    return () => controller.abort();
  }, [chatId, gatewayUrl, savedTerminalRefs, stoppedRef]);
  useEffect(() => { if (filePath) setLayout(current => ({ ...current, selected: "files" })); }, [filePath]);
  const overlay = rootWidth > 0 && rootWidth - railWidth < 600;
  const maxWidth = Math.max(240, Math.min(820, rootWidth - railWidth - 360));
  const width = Math.min(layout.width, maxWidth);
  const selectTab = (selected: Tab) => setLayout(current => ({ ...current, selected }));
  const createTerminal = async () => {
    if (terminalPending) return;
    setTerminalPending(true);
    setTerminalError(false);
    try {
      const ensured = await fetch(`${gatewayUrl}/api/terminal/workspaces/ensure`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(10_000) });
      if (!ensured.ok) throw new Error("TerminalUnavailable");
      const workspace = z.object({ workspace: z.object({ id: z.string().min(1).max(128) }) }).parse(await ensured.json()).workspace;
      const created = await fetch(`${gatewayUrl}/api/terminal/workspaces/${encodeURIComponent(workspace.id)}/tabs`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Chat terminal", cwd: "", chatId }), signal: AbortSignal.timeout(10_000),
      });
      if (!created.ok) throw new Error("TerminalUnavailable");
      const tab = z.object({ tab: z.object({ id: z.string().min(1).max(128) }) }).parse(await created.json()).tab;
      setTerminalRef(`${workspace.id}:${tab.id}`);
      selectTab("terminal");
    } catch (cause: unknown) {
      console.warn("[chat-inspector] Terminal create failed:", cause instanceof Error ? cause.name : "UnknownError");
      setTerminalError(true);
    } finally { setTerminalPending(false); }
  };
  const stopTerminal = async () => {
    const ref = terminalRef ? parseTerminalRefKey(terminalRef) : null;
    if (!ref || terminalPending) return;
    setTerminalPending(true);
    setTerminalError(false);
    try {
      const response = await fetch(`${gatewayUrl}/api/terminal/workspaces/${encodeURIComponent(ref.workspaceId)}/tabs/${encodeURIComponent(ref.tabId)}`, { method: "DELETE", signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error("TerminalUnavailable");
      setStoppedRef(terminalRef);
      setTerminalRef(null);
      setCloseTerminalConfirm(false);
      selectTab("files");
    } catch (cause: unknown) {
      console.warn("[chat-inspector] Terminal stop failed:", cause instanceof Error ? cause.name : "UnknownError");
      setTerminalError(true);
    } finally { setTerminalPending(false); }
  };
  const resize = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = event.clientX;
    const initial = layout.width;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => {
      const requested = initial + start - next.clientX;
      if (requested < 192) { onClose(); return; }
      setLayout(current => ({ ...current, width: Math.max(240, Math.min(maxWidth, requested)) }));
    };
    const end = () => { target.removeEventListener("pointermove", move); target.removeEventListener("pointerup", end); };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
  };
  const resizeTree = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = event.clientY;
    const initial = layout.treeHeight;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => {
      const height = panelRef.current?.clientHeight ?? 600;
      setLayout(current => ({ ...current, treeHeight: Math.max(120, Math.min(height - 200, initial + next.clientY - start)) }));
    };
    const end = () => { target.removeEventListener("pointermove", move); target.removeEventListener("pointerup", end); };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
  };
  return <><aside ref={panelRef} aria-label="Chat inspector" className={`${overlay ? "absolute inset-y-0 right-0 z-30" : "relative shrink-0"} flex min-h-0 flex-col border-l bg-background shadow-lg`}
    style={{ width: overlay ? Math.min(layout.width, rootWidth) : width }}>
    {!overlay ? <div role="separator" aria-label="Resize Chat inspector" aria-orientation="vertical" aria-valuemin={240} aria-valuemax={maxWidth} aria-valuenow={Math.round(width)} tabIndex={0}
      className="absolute -left-1 inset-y-0 z-20 w-2 cursor-col-resize" onPointerDown={resize} onDoubleClick={() => setLayout(current => ({ ...current, width: 400 }))}
      onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setLayout(current => ({ ...current, width: Math.max(240, Math.min(maxWidth, current.width + (event.key === "ArrowLeft" ? 16 : -16))) })); } }}/>: null}
    <div className="flex h-11 shrink-0 items-center gap-1 overflow-x-auto border-b px-2 text-xs">
      {(["files", "terminal", "side-chat"] as const).map(tab => <button key={tab} type="button" role="tab" aria-selected={layout.selected === tab} aria-label={tab === "side-chat" ? "Side chat" : tab === "files" ? "Files" : "Terminal"}
        className="rounded-md px-2 py-1 aria-selected:bg-accent" onClick={() => selectTab(tab)}>{tab === "side-chat" ? "Side chat" : tab === "files" ? "Files" : "Terminal"}</button>)}
      {layout.selected === "terminal" && terminalRef ? <button type="button" aria-label="Close terminal tab" onClick={() => setCloseTerminalConfirm(true)}>×</button> : null}
      <button type="button" className="ml-auto" aria-label="Close inspector" onClick={onClose}>×</button>
    </div>
    {layout.selected === "files" ? <div role="tabpanel" aria-label="Files" className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 shrink-0 flex-col overflow-hidden" style={{ height: filePath ? layout.treeHeight : undefined, flex: filePath ? undefined : 1 }}>
        <FileTree gatewayUrl={gatewayUrl} onOpenFile={path => onFilePathChange(path)}/>
      </div>
      {filePath ? <><div role="separator" aria-label="Resize file list" aria-orientation="horizontal" aria-valuenow={Math.round(layout.treeHeight)} tabIndex={0}
        className="h-2 shrink-0 cursor-row-resize border-y border-border" onPointerDown={resizeTree} onKeyDown={event => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); setLayout(current => ({ ...current, treeHeight: current.treeHeight + (event.key === "ArrowDown" ? 16 : -16) })); } }}/>
        <ChatFilePanel path={filePath} gatewayUrl={gatewayUrl} embedded onClose={() => onFilePathChange(null)}/></> : null}
    </div> : null}
    {layout.selected === "side-chat" ? <div role="tabpanel" aria-label="Side chat" className="flex min-h-0 flex-1 flex-col"><SideChatPanel chatId={chatId} client={sideChatClient} onSendToMain={onSendToMain}/></div> : null}
    {layout.selected === "terminal" ? <div role="tabpanel" aria-label="Terminal" className="relative flex min-h-0 flex-1 flex-col">
      {terminalRef ? <TerminalPane paneId={`chat-${chatId}`} cwd="" theme={theme} isFocused sessionId={terminalRef} chatId={chatId} shouldCacheOnUnmount={() => false}/>
        : <div className="p-3 text-sm"><p>No terminal is open for this chat.</p><button type="button" className="mt-2 rounded border px-3 py-1" disabled={terminalPending} onClick={() => { void createTerminal(); }}>New terminal</button></div>}
      {terminalError ? <p role="alert" className="px-3 text-xs text-destructive">The terminal could not be updated. Try again.</p> : null}
    </div> : null}
  </aside>
  <Dialog open={closeTerminalConfirm} onOpenChange={open => { if (!open && !terminalPending) setCloseTerminalConfirm(false); }}>
    <DialogContent role="alertdialog" aria-label="Stop this terminal?" showCloseButton={false} className="sm:max-w-[400px]"
      style={{ zIndex: SHELL_Z_INDEX.appDialog }} overlayStyle={{ zIndex: SHELL_Z_INDEX.appDialog }}>
      <DialogHeader><DialogTitle>Stop this terminal?</DialogTitle><DialogDescription>Closing this tab stops its terminal session.</DialogDescription></DialogHeader>
      <DialogFooter><Button type="button" variant="ghost" disabled={terminalPending} onClick={() => setCloseTerminalConfirm(false)}>Cancel</Button>
        <Button type="button" variant="destructive" disabled={terminalPending} onClick={() => { void stopTerminal(); }}>Stop terminal</Button></DialogFooter>
    </DialogContent>
  </Dialog></>;
}
