import { toast } from "sonner";
import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Folder, Plus, X } from "@renderer/lib/hugeicons";
import RetainedPane from "../../design/RetainedPane";
import { useFilesNavigation } from "../../stores/files-navigation";
import { isCurrentRuntimeGeneration } from "../../stores/runtime-generation";
import { useConnection } from "../../stores/connection";
import ComputerFileBrowser, { type BrowserSelection } from "./ComputerFileBrowser";
import { DesktopResourceSharing } from "./DesktopResourceSharing";
import { DesktopOrganizationDrivesView } from "./DesktopOrganizationDrivesView";
import { PreviewPane, resolveActivePath, type FileSelection } from "./FilePreviewPane";
import { openExactFileInDesktopEditor } from "../editor/desktop-editor-store";

export { resolveActivePath } from "./FilePreviewPane";
export type { FileSelection } from "./FilePreviewPane";

import { useDesktopFileDownload } from "./use-file-download";
import { useFileTrash } from "./use-file-trash";
import { useCreateItemDialog } from "./use-create-item-dialog";
import { FileDownloadStatus } from "./FileDownloadStatus";
import { InspectorFilesPanel, InspectorFilePreview, type InspectorFileTarget } from "../panels/InspectorFilesPanel";

const MAX_FILE_TABS = 12;

interface FileTab { id: string; path: string; initialPath: string; title: string; project?: { target: Extract<InspectorFileTarget, { kind: "project" }>; directory: boolean; revealKey?: string } }
const HOME_TAB: FileTab = { id: "files-home", path: "", initialPath: "", title: "Matrix home" };
const ORGANIZATION_DRIVES_TAB = "organization-drives";

function pathTitle(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? "Matrix home";
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
  const nextTabId = useRef(1);
  const currentTabs = useRef(tabs);

  useLayoutEffect(() => {
    currentTabs.current = tabs;
  }, [tabs]);

  const trash = useFileTrash(runtimeSlot, authGeneration, (path, removed) => {
    const contains = (target: string) => target === path || target.startsWith(`${path}/`);
    const parent = path.split("/").slice(0, -1).join("/");
    const affected = currentTabs.current.filter((tab) => !tab.project && (tab.path === parent || contains(tab.path)));
    setRefreshes((current) => {
      const next = { ...current };
      for (const tab of affected) next[tab.id] = (current[tab.id] ?? 0) + 1;
      return next;
    });
    if (removed) setSelections((current) => Object.fromEntries(
      Object.entries(current).map(([tabId, selection]) => [tabId, selection && contains(selection.path) ? null : selection]),
    ));
  });

  const { request: requestNewItem, cancelForTab: cancelNewItemForTab, dialog: createItemDialog } = useCreateItemDialog((tabId) => setRefreshes((current) => ({
    ...current,
    [tabId]: (current[tabId] ?? 0) + 1,
  })));

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
  }, [runtimeSlot, authGeneration]);

  useEffect(() => {
    if (organizationStatus !== "none") return;
    setDriveOpened(false);
    setRequestedDrive(undefined);
    setActiveTabId((current) => current === ORGANIZATION_DRIVES_TAB ? HOME_TAB.id : current);
  }, [organizationStatus]);

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
    cancelNewItemForTab(tabId);
  }, [activeTabId, cancelNewItemForTab, tabs]);


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
                  allowTrash
                  // Keep the creation seed stable; current tab path is navigation output.
                  initialPath={tab.initialPath}
                  onPathChange={(path) => updateTabPath(tab.id, path)}
                  onSelectionChange={(next: BrowserSelection | null) => setSelections((current) => ({ ...current, [tab.id]: next ? { slot: runtimeSlot, authGeneration, path: next.path, entry: next.entry } : null }))}
                  onDownload={download.download}
                  downloadPending={download.pending}
                  onMoveToTrash={active ? trash.move : undefined}
                  trashPending={trash.pending}
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
              onEdit={(path) => {
                if (!openExactFileInDesktopEditor(path)) toast.error("The file could not be opened in the editor.");
              }}
              onClose={() => setSelections((current) => ({ ...current, [activeTabId]: null }))}
            />
          </Suspense>
        ) : null}
      </div>
      <FileDownloadStatus download={download} />
      {createItemDialog}
    </div>
  );
}
