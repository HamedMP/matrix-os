import { toast } from "sonner";
import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { FileLeafNameSchema } from "@matrix-os/contracts";
import { Folder, Plus, X } from "@renderer/lib/hugeicons";
import { Button, Dialog } from "../../design/primitives";
import RetainedPane from "../../design/RetainedPane";
import { AppError, toUserMessage } from "../../lib/errors";
import { useFilesNavigation } from "../../stores/files-navigation";
import { captureRuntimeGeneration, isCurrentRuntimeGeneration } from "../../stores/runtime-generation";
import { useConnection } from "../../stores/connection";
import ComputerFileBrowser, { type BrowserSelection } from "./ComputerFileBrowser";
import { DesktopResourceSharing } from "./DesktopResourceSharing";
import { DesktopOrganizationDrivesView } from "./DesktopOrganizationDrivesView";
import { PreviewPane, resolveActivePath, type FileSelection } from "./FilePreviewPane";
import { openExactFileInDesktopEditor, openFileInDesktopEditor } from "../editor/desktop-editor-store";

export { resolveActivePath } from "./FilePreviewPane";
export type { FileSelection } from "./FilePreviewPane";

import { useDesktopFileDownload } from "./use-file-download";
import { FileDownloadStatus } from "./FileDownloadStatus";
import { InspectorFilesPanel, InspectorFilePreview, type InspectorFileTarget } from "../panels/InspectorFilesPanel";

const MAX_FILE_TABS = 12;
const SAFE_FOLDER_NAME = /^[^/\\\u0000-\u001f]{1,128}$/;

interface FileTab { id: string; path: string; initialPath: string; title: string; project?: { target: Extract<InspectorFileTarget, { kind: "project" }>; directory: boolean; revealKey?: string } }
type NewItemKind = "file" | "folder";
interface NewItemRequest {
  kind: NewItemKind;
  generation: number;
  parentPath: string;
  tabId: string;
  runtimeSlot: string;
  authGeneration: number;
}
const HOME_TAB: FileTab = { id: "files-home", path: "", initialPath: "", title: "Matrix home" };
const ORGANIZATION_DRIVES_TAB = "organization-drives";

function pathTitle(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? "Matrix home";
}

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

export default function FilesWorkspace() {
  const navigation = useFilesNavigation(state => state.request);
  const download = useDesktopFileDownload();
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const organizationStatus = useConnection((state) => state.organizationStatus);
  const organizationDrivesAvailable = organizationStatus !== "none";
  const [tabs, setTabs] = useState<FileTab[]>([HOME_TAB]);
  const [activeTabId, setActiveTabId] = useState(HOME_TAB.id);
  const [driveOpened, setDriveOpened] = useState(false);
  const [requestedDrive, setRequestedDrive] = useState<{scopeId: string; id: string | undefined}>();
  const [selections, setSelections] = useState<Record<string, FileSelection | null>>({});
  const [refreshes, setRefreshes] = useState<Record<string, number>>({});
  const [newItemRequest, setNewItemRequest] = useState<NewItemRequest | null>(null);
  const [newItemName, setNewItemName] = useState("");
  const [newItemError, setNewItemError] = useState<string | null>(null);
  const [creatingItem, setCreatingItem] = useState(false);
  const nextTabId = useRef(1);
  const newItemInputRef = useRef<HTMLInputElement | null>(null);
  const pendingCreation = useRef<{ request: NewItemRequest; controller: AbortController } | null>(null);

  useLayoutEffect(() => () => {
    const operation = pendingCreation.current;
    pendingCreation.current = null;
    operation?.controller.abort();
  }, [runtimeSlot, authGeneration]);

  const activeSelection = selections[activeTabId] ?? null;
  const activePath = resolveActivePath(activeSelection, runtimeSlot, authGeneration);
  const previewSelection = activePath !== null && activeSelection?.entry?.type === "file"
    ? { path: activePath, entry: activeSelection.entry }
    : null;

  useEffect(() => {
    setSelections({});
    setTabs([HOME_TAB]);
    setActiveTabId(HOME_TAB.id);
    setDriveOpened(false);
    setRequestedDrive(undefined);
    setNewItemRequest(null);
    setNewItemName("");
    setNewItemError(null);
    setCreatingItem(false);
  }, [runtimeSlot, authGeneration]);

  useEffect(() => {
    if (organizationStatus !== "none") return;
    setDriveOpened(false);
    setRequestedDrive(undefined);
    setActiveTabId((current) => current === ORGANIZATION_DRIVES_TAB ? HOME_TAB.id : current);
  }, [organizationStatus]);

  useEffect(() => {
    if (newItemRequest !== null) newItemInputRef.current?.focus();
  }, [newItemRequest]);

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
    const tab = { id: `files-folder-${nextTabId.current++}`, path, initialPath: path, title };
    setTabs([...tabs, tab].slice(-MAX_FILE_TABS));
    setActiveTabId(tab.id);
  }, [tabs]);

  useEffect(() => {
    if (!navigation) return;
    useFilesNavigation.getState().consume(navigation);
    if (navigation.runtimeSlot !== runtimeSlot || navigation.authGeneration !== authGeneration || !isCurrentRuntimeGeneration(navigation.generation)) return;
    if (navigation.project) {
      const target = { ...navigation.project, label: pathTitle(navigation.project.path) };
      const id = `project:${target.projectId}:${target.worktreeId ?? "root"}`;
      const tab: FileTab = { id, path: target.path, initialPath: "", title: target.projectId, project: { target, directory: navigation.directory ?? false, revealKey: crypto.randomUUID() } };
      setTabs((current) => current.some((item) => item.id === id) ? current.map((item) => item.id === id ? tab : item) : [...current, tab].slice(-MAX_FILE_TABS));
      setActiveTabId(id);
      return;
    }
    if (navigation.driveScopeId && organizationDrivesAvailable) {
      setDriveOpened(true); setRequestedDrive({scopeId: navigation.driveScopeId, id: navigation.driveIntentId}); setActiveTabId(ORGANIZATION_DRIVES_TAB);
    } else openFolderTab(navigation.path);
  }, [navigation, runtimeSlot, authGeneration, openFolderTab, organizationDrivesAvailable]);

  const visibleActiveTabId = activeTabId === ORGANIZATION_DRIVES_TAB && !organizationDrivesAvailable
    ? HOME_TAB.id
    : activeTabId;

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
    if (pendingCreation.current?.request.tabId === tabId) {
      pendingCreation.current.controller.abort();
      pendingCreation.current = null;
      setCreatingItem(false);
    }
    setNewItemRequest((current) => current?.tabId === tabId ? null : current);
  }, [activeTabId, tabs]);

  const requestNewItem = useCallback((kind: NewItemKind, tabId: string, parentPath: string) => {
    if (pendingCreation.current) return;
    setNewItemRequest({ kind, parentPath, tabId, runtimeSlot, authGeneration, generation: captureRuntimeGeneration() });
    setNewItemName("");
    setNewItemError(null);
  }, [authGeneration, runtimeSlot]);

  const createItem = async () => {
    const request = newItemRequest;
    if (!request || pendingCreation.current) return;
    const name = newItemName.trim();
    const validName = request.kind === "file"
      ? FileLeafNameSchema.safeParse(name).success
      : SAFE_FOLDER_NAME.test(name) && name !== "." && name !== "..";
    if (!validName) {
      setNewItemError(`Enter a ${request.kind} name without slashes.`);
      return;
    }

    const connection = useConnection.getState();
    const currentAuthority = () => {
      const current = useConnection.getState();
      return isCurrentRuntimeGeneration(request.generation)
        && current.runtimeSlot === request.runtimeSlot && current.authGeneration === request.authGeneration;
    };
    if (!connection.api || !currentAuthority()) {
      setNewItemError(`This computer changed. Reopen New ${request.kind} and try again.`);
      return;
    }
    const operation = { request, controller: new AbortController() };
    pendingCreation.current = operation;
    const requestStillCurrent = () => pendingCreation.current === operation && currentAuthority();
    const path = joinPath(request.parentPath, name);
    setCreatingItem(true);
    setNewItemError(null);
    try {
      if (request.kind === "file") {
        const response = await connection.api.forRuntime(request.runtimeSlot).post<{ ok?: boolean }>("/api/files/touch", { path }, {
          signal: operation.controller.signal, maxBytes: 4096, omitErrorBody: true,
        });
        if (!response.ok) throw new Error("File creation failed");
      } else {
        await connection.api.post("/api/files/mkdir", { path });
      }
      if (!requestStillCurrent()) return;
      setRefreshes((current) => ({
        ...current,
        [request.tabId]: (current[request.tabId] ?? 0) + 1,
      }));
      setNewItemRequest(null);
      if (request.kind === "file" && !openExactFileInDesktopEditor(path)) {
        toast.error("File created, but it could not be opened in the editor.");
      }
    } catch (error: unknown) {
      if (requestStillCurrent()) {
        setNewItemError(request.kind === "file" && error instanceof AppError && error.httpStatus === 409
          ? "The file name or folder is unavailable. Check the name and try again."
          : toUserMessage(error));
      }
    } finally {
      if (requestStillCurrent()) setCreatingItem(false);
      if (pendingCreation.current === operation) pendingCreation.current = null;
    }
  };
  const itemKind = newItemRequest?.kind ?? "folder";
  const itemLabel = itemKind === "file" ? "File" : "Folder";
  const closeCreationDialog = () => { if (!pendingCreation.current) setNewItemRequest(null); };

  return (
    <div className="flex min-h-0 flex-1 flex-col" style={{ background: "var(--bg-surface)" }}>
      <h1 className="sr-only">Files</h1>
      <div role="tablist" aria-label="Open folders" className="flex h-10 shrink-0 items-end gap-1 overflow-x-auto border-b px-2" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-app)" }}>
        {tabs.map((tab) => {
          const active = tab.id === visibleActiveTabId;
          return (
            <div key={tab.id} className="flex h-8 shrink-0 items-center rounded-t-lg border border-b-0" style={{ borderColor: "var(--border-subtle)", background: active ? "var(--bg-surface)" : "transparent" }}>
              <button type="button" role="tab" aria-selected={active} aria-label={tab.title} onClick={() => setActiveTabId(tab.id)} className="flex h-full max-w-48 items-center gap-2 px-3 text-xs font-medium outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]" style={{ color: active ? "var(--text-primary)" : "var(--text-tertiary)" }}>
                <Folder size={14} aria-hidden /><span className="truncate">{tab.title}</span>
              </button>
              {tabs.length > 1 ? <button type="button" aria-label={`Close ${tab.title}`} onClick={() => closeTab(tab.id)} className="mr-1 flex size-6 items-center justify-center rounded hover:bg-[var(--bg-hover)]" style={{ color: "var(--text-tertiary)" }}><X size={13} /></button> : null}
            </div>
          );
        })}
        {organizationDrivesAvailable ? <button type="button" role="tab" aria-selected={visibleActiveTabId === ORGANIZATION_DRIVES_TAB}
          onClick={() => { setDriveOpened(true); setActiveTabId(ORGANIZATION_DRIVES_TAB); }}
          className="flex h-8 shrink-0 items-center rounded-t-lg border border-b-0 px-3 text-xs font-medium outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
          style={{ borderColor: "var(--border-subtle)", background: visibleActiveTabId === ORGANIZATION_DRIVES_TAB ? "var(--bg-surface)" : "transparent",
            color: visibleActiveTabId === ORGANIZATION_DRIVES_TAB ? "var(--text-primary)" : "var(--text-tertiary)" }}>
          Organization drives
        </button> : null}
        {activePath && activeSelection?.entry ? <DesktopResourceSharing key={`${activeSelection.entry.type}:${activePath}`}
          kind={activeSelection.entry.type === "directory" ? "folder" : "file"} path={activePath} /> : null}
        <button type="button" aria-label="Open Matrix home in new tab" onClick={() => openFolderTab("", "Matrix home")} className="mb-1 flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-[var(--bg-hover)]" style={{ color: "var(--text-tertiary)" }}><Plus size={15} /></button>
      </div>
      <div data-testid="files-workspace-panes" data-layout={previewSelection ? "preview" : "browser"} className={`grid min-h-0 flex-1 grid-cols-1 overflow-hidden ${previewSelection ? "grid-rows-[minmax(220px,40%)_minmax(0,1fr)] md:grid-cols-[minmax(320px,3fr)_minmax(300px,2fr)] md:grid-rows-1" : "grid-rows-1"}`} style={{ background: "var(--bg-surface)" }}>
        <div data-testid="files-home-content" className="flex min-h-0 min-w-0 flex-col">
          {tabs.map((tab) => {
            const active = tab.id === visibleActiveTabId;
            return (
              <RetainedPane key={tab.id} active={active} visible={active}>
                {tab.project ? <div className="flex min-h-0 flex-1">
                  <section aria-label="Project files" className="flex min-h-0 w-64 shrink-0 flex-col border-r" style={{ borderColor: "var(--border-subtle)" }}>
                    <InspectorFilesPanel scope={{ kind: "project", chatId: tab.id, projectId: tab.project.target.projectId, worktreeId: tab.project.target.worktreeId, label: tab.title }} browserOnly revealKey={tab.project.revealKey} selectedDirectory={tab.project.directory} selectedFile={tab.project.target}
                      onOpenFile={(target) => { if (target.kind === "project") setTabs((current) => current.map((item) => item.id === tab.id ? { ...item, project: { target, directory: false } } : item)); }} />
                  </section>
                  {!tab.project.directory ? <InspectorFilePreview target={tab.project.target} /> : <p className="p-4 text-sm">Choose a file to preview.</p>}
                </div> : <ComputerFileBrowser
                  // Keep the creation seed stable; current tab path is navigation output.
                  initialPath={tab.initialPath}
                  onPathChange={(path) => updateTabPath(tab.id, path)}
                  onSelectionChange={(next: BrowserSelection | null) => setSelections((current) => ({ ...current, [tab.id]: next ? { slot: runtimeSlot, authGeneration, path: next.path, entry: next.entry } : null }))}
                  onDownload={download.download}
                  downloadPending={download.pending}
                  onOpenFolderInNewTab={openFolderTab}
                  onRequestCreateFolder={(parentPath) => requestNewItem("folder", tab.id, parentPath)}
                  onRequestCreateFile={(parentPath) => requestNewItem("file", tab.id, parentPath)}
                  refreshRevision={refreshes[tab.id] ?? 0}
                  framed={false}
                />}
              </RetainedPane>
            );
          })}
          {driveOpened && organizationDrivesAvailable && <RetainedPane active={visibleActiveTabId === ORGANIZATION_DRIVES_TAB} visible={visibleActiveTabId === ORGANIZATION_DRIVES_TAB}>
            <DesktopOrganizationDrivesView key={`${runtimeSlot}:${authGeneration}`} isActive={activeTabId === ORGANIZATION_DRIVES_TAB} requestedScopeId={requestedDrive?.scopeId} requestedIntentId={requestedDrive?.id} />
          </RetainedPane>}
        </div>
        {previewSelection ? (
          <Suspense fallback={<div className="flex flex-1 items-center justify-center text-xs" style={{ color: "var(--text-tertiary)" }}>Loading preview…</div>}>
            <PreviewPane
              key={previewSelection.path}
              selection={previewSelection}
              onDownload={download.download}
              downloadPending={download.pending}
              onEdit={openFileInDesktopEditor}
              onClose={() => setSelections((current) => ({ ...current, [activeTabId]: null }))}
            />
          </Suspense>
        ) : null}
      </div>
      <FileDownloadStatus download={download} />
      <Dialog open={newItemRequest !== null} onClose={closeCreationDialog} title={`New ${itemKind}`} width={400} placement="center">
        <form className="p-5" onSubmit={(event) => { event.preventDefault(); void createItem(); }}>
          <h2 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>New {itemKind}</h2>
          <p className="mt-1 text-xs" style={{ color: "var(--text-tertiary)" }}>Create inside {newItemRequest?.parentPath || "Matrix home"}.</p>
          <input ref={newItemInputRef} aria-label={`${itemLabel} name`} maxLength={128} disabled={creatingItem} value={newItemName} onChange={(event) => setNewItemName(event.target.value)} className="mt-4 h-10 w-full rounded-lg border px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]" style={{ borderColor: "var(--border-default)", background: "var(--bg-surface)", color: "var(--text-primary)" }} />
          {newItemError ? <p role="alert" className="mt-2 text-xs" style={{ color: "var(--danger)" }}>{newItemError}</p> : null}
          <div className="mt-5 flex justify-end gap-2"><Button type="button" variant="ghost" onClick={closeCreationDialog} disabled={creatingItem}>Cancel</Button><Button type="submit" variant="primary" disabled={creatingItem}>{creatingItem ? "Creating…" : `Create ${itemKind}`}</Button></div>
        </form>
      </Dialog>
    </div>
  );
}
