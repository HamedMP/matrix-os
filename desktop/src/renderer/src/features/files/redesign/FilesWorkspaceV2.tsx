import { ChevronDown, FilePlus, FolderPlus, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, DropdownMenu, Icon, type MenuEntry } from "../../../design/ds";
import RetainedPane from "../../../design/RetainedPane";
import { useConnection } from "../../../stores/connection";
import { useFilesNavigation } from "../../../stores/files-navigation";
import { isCurrentRuntimeGeneration } from "../../../stores/runtime-generation";
import { OSWindowSafeView } from "../../desktop-shell/OSWindow";
import { InspectorFilePreview, InspectorFilesPanel, type InspectorFileTarget } from "../../panels/InspectorFilesPanel";
import { isProtectedFolderCreationParentPath } from "../browser-entries";
import { DesktopOrganizationDrivesView } from "../DesktopOrganizationDrivesView";
import { FileDownloadStatus } from "../FileDownloadStatus";
import { FileTrashDialogs, useFileTrash } from "../FileTrashControls";
import { useCreateItemDialog } from "../use-create-item-dialog";
import { useDesktopFileDownload } from "../use-file-download";
import { FilesSidebar } from "./FilesSidebar";
import { FolderTabs } from "./FolderTabs";
import { FolderPane, pathTitle, type FolderPaneHandle } from "./FolderPane";
import { activeNavIdForPath, buildFilesNav, DRIVES_NAV_ID, pathForNavId, TRASH_NAV_ID } from "./files-locations";
import { useFolderListing } from "./use-folder-listing";
import { FILES_SIDEBAR_WIDTH } from "./files-sidebar-width";

const MAX_FILE_TABS = 12;

interface FileTab {
  id: string;
  path: string;
  initialPath: string;
  title: string;
  project?: { target: Extract<InspectorFileTarget, { kind: "project" }>; directory: boolean; revealKey?: string };
}

const HOME_TAB: FileTab = { id: "files-home", path: "", initialPath: "", title: "Matrix home" };

/**
 * Redesigned Electron Desktop Files (spec 2711): sidebar with locations,
 * organization drives and Trash; folder tabs; grid or list with multi-select;
 * details panel. Rendered instead of FilesWorkspace when the
 * `desktop-files-redesign` flag is on.
 */
export default function FilesWorkspaceV2() {
  const navigation = useFilesNavigation((state) => state.request);
  const download = useDesktopFileDownload();
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const organizationStatus = useConnection((state) => state.organizationStatus);
  const drivesAvailable = organizationStatus !== "none";
  const [tabs, setTabs] = useState<FileTab[]>([HOME_TAB]);
  const [activeTabId, setActiveTabId] = useState(HOME_TAB.id);
  const [drivesActive, setDrivesActive] = useState(false);
  const [drivesOpened, setDrivesOpened] = useState(false);
  const [requestedDrive, setRequestedDrive] = useState<{ scopeId: string; id: string | undefined }>();
  const [refreshes, setRefreshes] = useState<Record<string, number>>({});
  const [detailsOpen, setDetailsOpen] = useState(true);
  const nextId = useRef(1);
  const panes = useRef(new Map<string, FolderPaneHandle>());
  const root = useFolderListing("");

  const bump = useCallback((tabId: string) => setRefreshes((current) => ({ ...current, [tabId]: (current[tabId] ?? 0) + 1 })), []);
  const { request: requestNewItem, cancelForTab, dialog: createItemDialog } = useCreateItemDialog(bump);
  const trash = useFileTrash(true, () => bump(activeTabId));

  useEffect(() => {
    setTabs([HOME_TAB]);
    setActiveTabId(HOME_TAB.id);
    setDrivesActive(false);
    setDrivesOpened(false);
    setRequestedDrive(undefined);
  }, [runtimeSlot, authGeneration]);

  useEffect(() => {
    if (!drivesAvailable) setDrivesActive(false);
  }, [drivesAvailable]);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0]!;

  const openFolderTab = useCallback((path: string) => {
    setDrivesActive(false);
    const existing = tabs.find((tab) => tab.path === path && !tab.project);
    if (existing) { setActiveTabId(existing.id); return; }
    const tab: FileTab = { id: `files-folder-${nextId.current++}`, path, initialPath: path, title: pathTitle(path) };
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
      setDrivesActive(false);
      return;
    }
    if (navigation.driveScopeId && drivesAvailable) {
      setDrivesOpened(true);
      setDrivesActive(true);
      setRequestedDrive({ scopeId: navigation.driveScopeId, id: navigation.driveIntentId });
    } else openFolderTab(navigation.path);
  }, [navigation, runtimeSlot, authGeneration, openFolderTab, drivesAvailable]);

  const closeTab = useCallback((tabId: string) => {
    if (tabs.length === 1) return;
    const index = tabs.findIndex((tab) => tab.id === tabId);
    const next = tabs.filter((tab) => tab.id !== tabId);
    setTabs(next);
    if (activeTabId === tabId) setActiveTabId(next[Math.max(0, index - 1)]?.id ?? next[0]!.id);
    cancelForTab(tabId);
  }, [activeTabId, cancelForTab, tabs]);

  const updateTabPath = useCallback((tabId: string, path: string) => {
    setTabs((current) => current.map((tab) => tab.id === tabId ? { ...tab, path, title: pathTitle(path) } : tab));
  }, []);

  const selectNav = (id: string) => {
    if (id === TRASH_NAV_ID) { void trash.openTrash(); return; }
    if (id === DRIVES_NAV_ID) { setDrivesOpened(true); setDrivesActive(true); return; }
    const path = pathForNavId(id);
    if (path === null) return;
    setDrivesActive(false);
    const target = activeTab.project ? tabs.find((tab) => !tab.project) : activeTab;
    if (!target) { openFolderTab(path); return; }
    setActiveTabId(target.id);
    panes.current.get(target.id)?.navigate(path);
  };

  const nav = useMemo(() => buildFilesNav({ rootEntries: root.entries, drivesAvailable, trashCount: trash.entries?.length }), [drivesAvailable, root.entries, trash.entries]);
  const activeNavId = drivesActive ? DRIVES_NAV_ID : activeTab.project ? null : activeNavIdForPath(activeTab.path);
  const createParent = activeTab.project ? null : activeTab.path;
  const canCreate = !drivesActive && createParent !== null && !isProtectedFolderCreationParentPath(createParent);
  const newEntries: MenuEntry[] = canCreate ? [
    { kind: "item", id: "new-folder", label: "New folder", shortcut: "⇧⌘N", icon: <FolderPlus />, onSelect: () => requestNewItem("folder", activeTab.id, createParent) },
    { kind: "item", id: "new-file", label: "New file", shortcut: "⌥⌘N", icon: <FilePlus />, onSelect: () => requestNewItem("file", activeTab.id, createParent) },
  ] : [];

  const tabStrip = (
    <FolderTabs
      tabs={tabs.map((tab) => ({ id: tab.id, title: tab.title }))}
      activeId={drivesActive ? "" : activeTab.id}
      onSelect={(id) => { setDrivesActive(false); setActiveTabId(id); }}
      onClose={closeTab}
      onNewTab={() => {
        const tab: FileTab = { id: `files-folder-${nextId.current++}`, path: "", initialPath: "", title: "Matrix home" };
        setTabs([...tabs, tab].slice(-MAX_FILE_TABS));
        setActiveTabId(tab.id);
        setDrivesActive(false);
      }}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 bg-ds-background" data-testid="files-redesign">
      <h1 className="sr-only">Files</h1>
      <OSWindowSafeView area="sidebar" className="flex h-full min-h-0 shrink-0 flex-col border-r border-ds-tint-neutral-border bg-ds-card" style={{ width: FILES_SIDEBAR_WIDTH }}>
        <FilesSidebar
          header={newEntries.length > 0 ? (
            <DropdownMenu
              align="start"
              entries={newEntries}
              trigger={<Button variant="secondary" size="sm" className="mt-2 w-full justify-start"><Icon icon={Plus} size="sm" />New<Icon icon={ChevronDown} size="xs" className="ml-auto" /></Button>}
            />
          ) : undefined}
          sections={nav.sections}
          footer={nav.footer}
          activeId={activeNavId}
          onSelect={selectNav}
        />
      </OSWindowSafeView>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {tabs.map((tab) => {
          const active = !drivesActive && tab.id === activeTab.id;
          return (
            <RetainedPane key={tab.id} active={active} visible={active} className="min-h-0 min-w-0 flex-1 flex-col">
              {tab.project ? (
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="flex h-12 shrink-0 items-center border-b border-ds-tint-neutral-border px-3">{tabStrip}</div>
                  <div className="flex min-h-0 flex-1">
                    <section aria-label="Project files" className="flex min-h-0 w-64 shrink-0 flex-col border-r border-ds-tint-neutral-border">
                      <InspectorFilesPanel scope={{ kind: "project", chatId: tab.id, projectId: tab.project.target.projectId, worktreeId: tab.project.target.worktreeId, label: tab.title }} browserOnly revealKey={tab.project.revealKey} selectedDirectory={tab.project.directory} selectedFile={tab.project.target}
                        onOpenFile={(target) => { if (target.kind === "project") setTabs((current) => current.map((item) => item.id === tab.id ? { ...item, project: { target, directory: false } } : item)); }} />
                    </section>
                    {!tab.project.directory ? <InspectorFilePreview target={tab.project.target} /> : <p className="p-4 text-ds-ui-sm text-ds-muted-foreground">Choose a file to preview.</p>}
                  </div>
                </div>
              ) : (
                <FolderPane
                  initialPath={tab.initialPath}
                  ref={(handle) => {
                    if (handle) panes.current.set(tab.id, handle);
                    else panes.current.delete(tab.id);
                  }}
                  tabs={tabStrip}
                  refreshRevision={refreshes[tab.id] ?? 0}
                  detailsOpen={detailsOpen}
                  onDetailsOpenChange={setDetailsOpen}
                  onPathChange={(path) => updateTabPath(tab.id, path)}
                  onOpenFolderInNewTab={openFolderTab}
                  onRequestCreate={(kind, parent) => requestNewItem(kind, tab.id, parent)}
                  onDownload={download.download}
                  downloadPending={download.pending}
                  onRequestTrash={trash.requestMove}
                />
              )}
            </RetainedPane>
          );
        })}
        {drivesOpened && drivesAvailable ? (
          <RetainedPane active={drivesActive} visible={drivesActive} className="min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex h-12 shrink-0 items-center border-b border-ds-tint-neutral-border px-3">{tabStrip}</div>
            <DesktopOrganizationDrivesView key={`${runtimeSlot}:${authGeneration}`} isActive={drivesActive} requestedScopeId={requestedDrive?.scopeId} requestedIntentId={requestedDrive?.id} />
          </RetainedPane>
        ) : null}
      </div>
      <FileTrashDialogs trash={trash} />
      <FileDownloadStatus download={download} />
      {createItemDialog}
    </div>
  );
}
