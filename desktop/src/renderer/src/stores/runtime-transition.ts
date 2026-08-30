import { resetAttachManager } from "../features/terminal/terminal-runtime";
import { useEditorTabs } from "../features/editor/editor-tabs-store";
import { resetKernel } from "../lib/kernel-wiring";
import { useBoard } from "./board";
import { useHermesChat } from "./hermes-chat";
import { clearInspectorLayoutRuntime } from "../features/panels/inspector-layout-store";
import { clearPluginsRuntime } from "../features/plugins/plugins-store";
import { clearProjectViewRuntime } from "./project-view";
import { useProjectLifecycle } from "./project-lifecycle";
import { clearProjectWorkspaces } from "./project-workspaces";
import { clearCodingAgentRuntimeSelection } from "./coding-agent-workspace";
import { clearDraftChats } from "./draft-chat";
import { useFileTree } from "./file-tree";
import { useGit } from "./git";
import { useSessions } from "./sessions";
import { useShellSessions } from "./shell-sessions";
import { useTabs } from "./tabs";
import { useThreads } from "./threads";
import { useUi } from "./ui";
import { useWorkspace } from "./workspace";
import { advanceRuntimeGeneration } from "./runtime-generation";
import { resetAppsRuntime } from "./apps";
import { useDesktopSurfaces } from "./desktop-surfaces";
import { resetDesktopIconsRuntime } from "./desktop-icons";
import { useCreateAppRequest } from "./create-app-request";

interface RuntimeChangeOptions {
  disposeRuntimeAttachments?: () => void;
}

/**
 * Synchronously removes every renderer reference owned by the previous
 * computer before the selected runtime becomes observable to the UI.
 */
export function reconcileDesktopRuntimeChange(options: RuntimeChangeOptions = {}): void {
  advanceRuntimeGeneration();
  (options.disposeRuntimeAttachments ?? resetAttachManager)();
  resetKernel();
  useBoard.setState({
    projects: [],
    projectsStatus: "idle",
    projectsError: null,
    activeProjectSlug: null,
    cardsByProject: {},
    firstLoadByProject: {},
    refreshing: false,
    error: null,
  });
  useProjectLifecycle.setState({
    archivedProjects: [],
    loading: false,
    pendingProjectSlug: null,
    error: null,
  });
  useTabs.setState({
    tabs: [],
    activeTabId: null,
    navigationScope: null,
    terminalSessionRequest: null,
    terminalSessionRequestSequence: 0,
  });
  useDesktopSurfaces.setState(useDesktopSurfaces.getInitialState(), true);
  resetDesktopIconsRuntime();
  useCreateAppRequest.setState({ request: null });
  // The Hermes index, transcript, and kernel session follow the selected
  // computer; invalidate in-flight list/history requests before the new API is
  // published so prior-owner data cannot repopulate the next runtime.
  useHermesChat.getState().resetRuntime();
  useSessions.setState({
    sessions: [],
    aliasMap: {},
    loading: false,
    creating: false,
    error: null,
    createError: null,
  });
  useShellSessions.setState((state) => ({
    sessions: [],
    loading: false,
    creating: false,
    error: null,
    loadSequence: state.loadSequence + 1,
    authoritativeRevision: 0,
  }));
  useGit.setState({
    branches: [],
    prs: [],
    worktrees: [],
    previews: [],
    previewScope: null,
    refreshedAt: null,
    loading: false,
    error: null,
    previewError: null,
  });
  useWorkspace.setState({ entries: [] });
  useEditorTabs.setState({ tabsByTask: {}, activePathByTask: {}, dirtyPathsByTask: {} });
  useFileTree.setState({
    roots: null,
    childrenByPath: {},
    expanded: {},
    loadingRoots: false,
    loadingPaths: {},
  });
  useThreads.setState({ threads: [], activeThreadId: null });
  resetAppsRuntime();
  clearCodingAgentRuntimeSelection();
  clearDraftChats();
  clearProjectWorkspaces();
  clearProjectViewRuntime();
  clearInspectorLayoutRuntime();
  clearPluginsRuntime();
  useUi.setState({
    createProjectOpen: false,
    composerOpen: false,
    paletteOpen: false,
    quickOpenOpen: false,
    appLauncherOpen: false,
    rendererOverlayCount: 0,
  });
}
