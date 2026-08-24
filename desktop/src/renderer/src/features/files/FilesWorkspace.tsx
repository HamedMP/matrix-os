import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Folder, Plus, X } from "lucide-react";
import { Button, Dialog } from "../../design/primitives";
import RetainedPane from "../../design/RetainedPane";
import { toUserMessage } from "../../lib/errors";
import { useConnection } from "../../stores/connection";
import ComputerFileBrowser, { type BrowserSelection } from "./ComputerFileBrowser";
import { PreviewPane, resolveActivePath, type FileSelection } from "./FilePreviewPane";

export { resolveActivePath } from "./FilePreviewPane";
export type { FileSelection } from "./FilePreviewPane";

const MAX_FILE_TABS = 12;
const SAFE_FOLDER_NAME = /^[^/\\\u0000-\u001f]{1,128}$/;

interface FileTab { id: string; path: string; title: string }
const HOME_TAB: FileTab = { id: "files-home", path: "", title: "Matrix home" };

function pathTitle(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? "Matrix home";
}

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

export default function FilesWorkspace() {
  const api = useConnection((state) => state.api);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const [tabs, setTabs] = useState<FileTab[]>([HOME_TAB]);
  const [activeTabId, setActiveTabId] = useState(HOME_TAB.id);
  const [selections, setSelections] = useState<Record<string, FileSelection | null>>({});
  const [refreshes, setRefreshes] = useState<Record<string, number>>({});
  const [newFolderParent, setNewFolderParent] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderError, setNewFolderError] = useState<string | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const nextTabId = useRef(1);
  const newFolderInputRef = useRef<HTMLInputElement | null>(null);

  const activeSelection = selections[activeTabId] ?? null;
  const activePath = resolveActivePath(activeSelection, runtimeSlot, authGeneration);
  const previewSelection = activePath !== null && activeSelection?.entry?.type === "file"
    ? { path: activePath, entry: activeSelection.entry }
    : null;

  useEffect(() => {
    setSelections({});
    setTabs([HOME_TAB]);
    setActiveTabId(HOME_TAB.id);
  }, [runtimeSlot, authGeneration]);

  useEffect(() => {
    if (newFolderParent !== null) newFolderInputRef.current?.focus();
  }, [newFolderParent]);

  const updateTabPath = useCallback((tabId: string, path: string) => {
    setTabs((current) => current.map((tab) => tab.id === tabId
      ? { ...tab, path, title: pathTitle(path) }
      : tab));
  }, []);

  const openFolderTab = useCallback((path: string, title = pathTitle(path)) => {
    const existing = tabs.find((tab) => tab.path === path);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const tab = { id: `files-folder-${nextTabId.current++}`, path, title };
    setTabs([...tabs, tab].slice(-MAX_FILE_TABS));
    setActiveTabId(tab.id);
  }, [tabs]);

  const closeTab = useCallback((tabId: string) => {
    if (tabs.length === 1) return;
    const index = tabs.findIndex((tab) => tab.id === tabId);
    const next = tabs.filter((tab) => tab.id !== tabId);
    setTabs(next);
    if (activeTabId === tabId) {
      setActiveTabId(next[Math.max(0, index - 1)]?.id ?? next[0]!.id);
    }
    setSelections((current) => {
      const next = { ...current };
      delete next[tabId];
      return next;
    });
  }, [activeTabId, tabs]);

  const requestNewFolder = useCallback((parentPath: string) => {
    setNewFolderParent(parentPath);
    setNewFolderName("");
    setNewFolderError(null);
  }, []);

  const createFolder = useCallback(async () => {
    const name = newFolderName.trim();
    if (!api || newFolderParent === null || !SAFE_FOLDER_NAME.test(name) || name === "." || name === "..") {
      setNewFolderError("Enter a folder name without slashes.");
      return;
    }
    setCreatingFolder(true);
    setNewFolderError(null);
    try {
      await api.post("/api/files/mkdir", { path: joinPath(newFolderParent, name) });
      setRefreshes((current) => ({ ...current, [activeTabId]: (current[activeTabId] ?? 0) + 1 }));
      setNewFolderParent(null);
    } catch (err: unknown) {
      setNewFolderError(toUserMessage(err));
    } finally {
      setCreatingFolder(false);
    }
  }, [activeTabId, api, newFolderName, newFolderParent]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" style={{ background: "var(--bg-surface)" }}>
      <h1 className="sr-only">Files</h1>
      <div role="tablist" aria-label="Open folders" className="flex h-10 shrink-0 items-end gap-1 overflow-x-auto border-b px-2" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-app)" }}>
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          return (
            <div key={tab.id} className="flex h-8 shrink-0 items-center rounded-t-lg border border-b-0" style={{ borderColor: "var(--border-subtle)", background: active ? "var(--bg-surface)" : "transparent" }}>
              <button type="button" role="tab" aria-selected={active} aria-label={tab.title} onClick={() => setActiveTabId(tab.id)} className="flex h-full max-w-48 items-center gap-2 px-3 text-xs font-medium outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]" style={{ color: active ? "var(--text-primary)" : "var(--text-tertiary)" }}>
                <Folder size={14} aria-hidden /><span className="truncate">{tab.title}</span>
              </button>
              {tabs.length > 1 ? <button type="button" aria-label={`Close ${tab.title}`} onClick={() => closeTab(tab.id)} className="mr-1 flex size-6 items-center justify-center rounded hover:bg-[var(--bg-hover)]" style={{ color: "var(--text-tertiary)" }}><X size={13} /></button> : null}
            </div>
          );
        })}
        <button type="button" aria-label="Open Matrix home in new tab" onClick={() => openFolderTab("", "Matrix home")} className="mb-1 flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-[var(--bg-hover)]" style={{ color: "var(--text-tertiary)" }}><Plus size={15} /></button>
      </div>
      <div data-testid="files-workspace-panes" data-layout={previewSelection ? "preview" : "browser"} className={`grid min-h-0 flex-1 grid-cols-1 overflow-hidden ${previewSelection ? "grid-rows-[minmax(220px,40%)_minmax(0,1fr)] md:grid-cols-[minmax(320px,3fr)_minmax(300px,2fr)] md:grid-rows-1" : "grid-rows-1"}`} style={{ background: "var(--bg-surface)" }}>
        <div data-testid="files-home-content" className="flex min-h-0 min-w-0 flex-col">
          {tabs.map((tab) => {
            const active = tab.id === activeTabId;
            return (
              <RetainedPane key={tab.id} active={active} visible={active}>
                <ComputerFileBrowser
                  initialPath={tab.path}
                  onPathChange={(path) => updateTabPath(tab.id, path)}
                  onSelectionChange={(next: BrowserSelection | null) => setSelections((current) => ({ ...current, [tab.id]: next ? { slot: runtimeSlot, authGeneration, path: next.path, entry: next.entry } : null }))}
                  onOpenFolderInNewTab={openFolderTab}
                  onRequestCreateFolder={requestNewFolder}
                  refreshRevision={refreshes[tab.id] ?? 0}
                  framed={false}
                />
              </RetainedPane>
            );
          })}
        </div>
        {previewSelection ? (
          <Suspense fallback={<div className="flex flex-1 items-center justify-center text-xs" style={{ color: "var(--text-tertiary)" }}>Loading preview…</div>}>
            <PreviewPane key={previewSelection.path} selection={previewSelection} onClose={() => setSelections((current) => ({ ...current, [activeTabId]: null }))} />
          </Suspense>
        ) : null}
      </div>
      <Dialog open={newFolderParent !== null} onClose={() => setNewFolderParent(null)} title="New folder" width={400} placement="center">
        <form className="p-5" onSubmit={(event) => { event.preventDefault(); void createFolder(); }}>
          <h2 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>New folder</h2>
          <p className="mt-1 text-xs" style={{ color: "var(--text-tertiary)" }}>Create inside {newFolderParent || "Matrix home"}.</p>
          <input ref={newFolderInputRef} aria-label="Folder name" value={newFolderName} onChange={(event) => setNewFolderName(event.target.value)} className="mt-4 h-10 w-full rounded-lg border px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]" style={{ borderColor: "var(--border-default)", background: "var(--bg-surface)", color: "var(--text-primary)" }} />
          {newFolderError ? <p role="alert" className="mt-2 text-xs" style={{ color: "var(--danger)" }}>{newFolderError}</p> : null}
          <div className="mt-5 flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setNewFolderParent(null)}>Cancel</Button><Button type="submit" variant="primary" disabled={creatingFolder}>{creatingFolder ? "Creating…" : "Create folder"}</Button></div>
        </form>
      </Dialog>
    </div>
  );
}
