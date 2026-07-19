import { resetAttachManager } from "../features/terminal/terminal-runtime";
import { useEditorTabs } from "../features/editor/editor-tabs-store";
import { resetKernel } from "../lib/kernel-wiring";
import { useBoard } from "./board";
import { useHermesChat } from "./hermes-chat";
import { clearProjectViewRuntime } from "./project-view";
import { clearProjectWorkspaces } from "./project-workspaces";
import { clearCodingAgentRuntimeSelection } from "./coding-agent-workspace";
import { useFileTree } from "./file-tree";
import { useGit } from "./git";
import { useSessions } from "./sessions";
import { useShellSessions } from "./shell-sessions";
import { useTabs } from "./tabs";
import { useThreads } from "./threads";
import { useUi } from "./ui";
import { useWorkspace } from "./workspace";
import { advanceRuntimeGeneration } from "./runtime-generation";

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
    activeProjectSlug: null,
    cardsByProject: {},
    firstLoadByProject: {},
    refreshing: false,
    error: null,
  });
  useTabs.setState({ tabs: [], activeTabId: null });
  // MissionControl only opens Home in its mount-only effect, so reopen it here
  // or a successful switch leaves the already-mounted desktop with no active tab.
  useTabs.getState().openTab({ kind: "home", title: "Home", closable: false });
  // The Hermes transcript and kernel session follow the selected computer; the
  // kernel socket is already reset above, so drop the chat state with it.
  useHermesChat.setState({ messages: [], sessionId: null, status: "idle", activeRequestId: null });
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
  clearCodingAgentRuntimeSelection();
  clearProjectWorkspaces();
  clearProjectViewRuntime();
  useUi.setState({
    createProjectOpen: false,
    createTaskOpen: false,
    createTaskStatus: null,
    composerOpen: false,
    paletteOpen: false,
    quickOpenOpen: false,
  });
}
