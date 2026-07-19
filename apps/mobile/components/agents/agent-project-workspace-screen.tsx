import { useCallback, useEffect, useRef, useState } from "react";
import * as ReactNative from "react-native";
import {
  ActivityIndicator,
  AppState,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useUnistyles } from "react-native-unistyles";
import {
  ProjectIdSchema,
  type AgentThreadSummary,
  type ProjectAgentWorkspace,
  type RuntimeSummary,
} from "@matrix-os/contracts";
import type {
  CodingAgentProjectWorkspaceOptions,
  CodingAgentProjectWorkspaceResult,
  ConnectionState,
  GatewayClient,
} from "@/lib/gateway-client";
import {
  AgentProjectKanban,
  AgentProjectViewModeControl,
} from "@/components/agents/agent-project-kanban";
import { AgentProjectConversation } from "@/components/agents/agent-project-conversation";
import {
  countLabel,
  includeWorkspaceProject,
  runtimeCapabilityEnabled,
} from "@/components/agents/agent-project-utils";
import {
  loadAgentWorkspaceState,
  reconcileAgentWorkspaceState,
  saveAgentWorkspaceState,
  selectAgentWorkspaceProject,
  selectAgentWorkspaceThread,
  selectAgentWorkspaceViewMode,
  type AgentWorkspaceState,
  type AgentWorkspaceViewMode,
} from "@/lib/agent-workspace-state";
import { agentProjectWorkspaceStyles as styles } from "@/components/agents/agent-project-workspace-styles";

type ProjectWorkspaceClient = Pick<
  GatewayClient,
  "connect" | "getCodingAgentRuntimeSummary" | "getCodingAgentProjectWorkspace"
>;

export interface AgentConversationIdentity {
  projectId: string;
  taskId: string | null;
  threadId: string;
}

interface ReadyWorkspaceState {
  summary: RuntimeSummary;
  workspace: ProjectAgentWorkspace;
  selection: AgentWorkspaceState;
  refreshing: boolean;
  loadingMore: boolean;
  warning: string | null;
}

type ProjectScreenState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; value: ReadyWorkspaceState };

interface AgentProjectWorkspaceScreenProps {
  client: ProjectWorkspaceClient | null;
  connectionState: ConnectionState;
  requestedProjectId?: string | null;
  onOpenProject: (projectId: string) => void;
  onOpenThread: (identity: AgentConversationIdentity) => void;
  onNewConversation: (identity: { projectId: string; taskId: string | null }) => void;
  onViewModeChange?: (viewMode: AgentWorkspaceViewMode) => void;
  routeViewMode?: AgentWorkspaceViewMode | null;
  contentBottomInset?: number;
}

const PROJECT_WORKSPACE_ERROR = "Project workspace unavailable. Refresh or choose another project.";
const MAX_ACCUMULATED_WORKSPACE_ITEMS = 300;

export function AgentProjectList({
  summary,
  onOpenProject,
}: {
  summary: RuntimeSummary;
  onOpenProject: (projectId: string) => void;
}) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.entrySection}>
      <Text selectable style={styles.entryHeading}>Projects</Text>
      {summary.projects.items.length === 0 ? (
        <Text selectable style={styles.emptyText}>No coding projects are available.</Text>
      ) : null}
      {summary.projects.items.map((project) => (
        <Pressable
          key={project.id}
          accessibilityRole="button"
          accessibilityLabel={`Open project ${project.label}`}
          onPress={() => onOpenProject(project.id)}
          style={({ pressed }) => [styles.projectEntry, pressed ? styles.pressed : null]}
        >
          <View style={styles.projectIcon}>
            <Ionicons name="folder-open-outline" size={18} color={theme.colors.moss} />
          </View>
          <View style={styles.projectEntryText}>
            <Text selectable style={styles.rowTitle}>{project.label}</Text>
            <Text selectable style={styles.rowSubtitle}>
              {countLabel(project.taskCount, "task")} · {countLabel(project.threadCount, "conversation")}
            </Text>
            {project.attentionCount > 0 ? (
              <Text selectable style={styles.attentionText}>
                {project.attentionCount} needs attention
              </Text>
            ) : null}
          </View>
          <Ionicons name="chevron-forward" size={18} color={theme.colors.mutedForeground} />
        </Pressable>
      ))}
    </View>
  );
}

export function AgentProjectWorkspaceScreen({
  client,
  connectionState,
  requestedProjectId,
  onOpenProject,
  onOpenThread,
  onNewConversation,
  onViewModeChange,
  routeViewMode = null,
  contentBottomInset = 40,
}: AgentProjectWorkspaceScreenProps) {
  const { theme } = useUnistyles();
  const { width } = ReactNative.useWindowDimensions();
  const [state, setState] = useState<ProjectScreenState>({ status: "loading" });
  const generationRef = useRef(0);
  const appliedRouteViewSeedRef = useRef<string | null>(null);
  const stateRef = useRef<ProjectScreenState>(state);
  const previousConnectionStateRef = useRef(connectionState);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const hydrate = useCallback(async () => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const retained = stateRef.current.status === "ready" ? stateRef.current.value : null;
    if (retained) {
      setState({ status: "ready", value: { ...retained, refreshing: true, loadingMore: false, warning: null } });
    } else {
      setState({ status: "loading" });
    }

    if (!client) {
      setHydrationFailure(generationRef, generation, retained, setState);
      return;
    }
    const parsedRequestedProject = requestedProjectId === null || requestedProjectId === undefined
      ? null
      : ProjectIdSchema.safeParse(requestedProjectId);
    if (parsedRequestedProject && !parsedRequestedProject.success) {
      setHydrationFailure(generationRef, generation, retained, setState);
      return;
    }

    const [restored, summaryResult] = await Promise.all([
      loadAgentWorkspaceState(),
      client.getCodingAgentRuntimeSummary(),
    ]);
    if (generation !== generationRef.current) return;
    if (!summaryResult.ok || !projectWorkspaceCapabilitiesEnabled(summaryResult.summary)) {
      setHydrationFailure(generationRef, generation, retained, setState);
      return;
    }

    let liveSummary = summaryResult.summary;
    let selection = reconcileAgentWorkspaceState(restored, liveSummary);
    const desiredProjectId = parsedRequestedProject?.success
      ? parsedRequestedProject.data
      : selection.selectedProjectId ?? liveSummary.projects.items[0]?.id ?? null;
    if (!desiredProjectId) {
      setHydrationFailure(generationRef, generation, retained, setState, "No coding projects are available.");
      return;
    }
    let requestedExists = liveSummary.projects.items.some(
      (project) => project.id === desiredProjectId,
    );
    let workspaceResult: CodingAgentProjectWorkspaceResult | null = null;
    const requestedWorkspaceResult = requestedExists
      ? null
      : await client.getCodingAgentProjectWorkspace({ projectId: desiredProjectId });
    if (generation !== generationRef.current) return;
    if (
      requestedWorkspaceResult?.ok
      && requestedWorkspaceResult.workspace.project.id === desiredProjectId
    ) {
      workspaceResult = requestedWorkspaceResult;
      liveSummary = includeWorkspaceProject(liveSummary, requestedWorkspaceResult.workspace);
      selection = reconcileAgentWorkspaceState(restored, liveSummary);
      requestedExists = true;
    }
    if (requestedExists) {
      selection = selectAgentWorkspaceProject(
        selection,
        liveSummary,
        desiredProjectId,
      );
    }
    const selectedProjectId = selection.selectedProjectId;
    if (!selectedProjectId) {
      setHydrationFailure(generationRef, generation, retained, setState, "No coding projects are available.");
      return;
    }

    workspaceResult ??= await client.getCodingAgentProjectWorkspace({ projectId: selectedProjectId });
    if (generation !== generationRef.current) return;
    if (!workspaceResult.ok || workspaceResult.workspace.project.id !== selectedProjectId) {
      setHydrationFailure(generationRef, generation, retained, setState);
      return;
    }

    selection = reconcileAgentWorkspaceState(selection, liveSummary, workspaceResult.workspace);
    const canShowKanban = kanbanViewEnabled(liveSummary);
    const routeViewSeedKey = routeViewMode ? `${selectedProjectId}:${routeViewMode}` : null;
    const canApplyRouteView = routeViewMode === "conversation"
      || (routeViewMode === "kanban" && canShowKanban);
    const routeViewModeToApply = (
      routeViewSeedKey
      && appliedRouteViewSeedRef.current !== routeViewSeedKey
      && canApplyRouteView
    ) ? routeViewMode : null;
    if (routeViewModeToApply) {
      selection = selectAgentWorkspaceViewMode(selection, routeViewModeToApply);
    } else if (!canShowKanban && selection.viewMode === "kanban") {
      selection = selectAgentWorkspaceViewMode(selection, "conversation");
    }
    selection = {
      ...selection,
      updatedAt: new Date().toISOString(),
    };
    await persistSelection(selection);
    if (generation !== generationRef.current) return;
    if (routeViewModeToApply) appliedRouteViewSeedRef.current = routeViewSeedKey;
    if (!routeViewMode) appliedRouteViewSeedRef.current = null;
    setState({
      status: "ready",
      value: {
        summary: liveSummary,
        workspace: workspaceResult.workspace,
        selection,
        refreshing: false,
        loadingMore: false,
        warning: requestedExists ? null : "The previous project was unavailable. Showing a live project instead.",
      },
    });
    if (requestedProjectId && !requestedExists && selectedProjectId !== requestedProjectId) {
      onOpenProject(selectedProjectId);
    }
  }, [client, onOpenProject, requestedProjectId, routeViewMode]);

  useEffect(() => {
    const timeoutId = setTimeout(() => void hydrate(), 0);
    return () => {
      clearTimeout(timeoutId);
      generationRef.current += 1;
    };
  }, [hydrate]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") {
        void hydrate();
      }
    });
    return () => subscription.remove();
  }, [hydrate]);

  useEffect(() => {
    const previousConnectionState = previousConnectionStateRef.current;
    previousConnectionStateRef.current = connectionState;
    if (connectionState === "connected" && previousConnectionState !== "connected") {
      const timeoutId = setTimeout(() => void hydrate(), 0);
      return () => clearTimeout(timeoutId);
    }
    return undefined;
  }, [connectionState, hydrate]);

  if (state.status === "loading") {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={theme.colors.forest} />
        <Text selectable style={styles.centerTitle}>Loading project conversations…</Text>
      </View>
    );
  }

  if (state.status === "error") {
    return (
      <View style={styles.centered}>
        <Ionicons name="warning-outline" size={28} color={theme.colors.moss} />
        <Text selectable style={styles.centerTitle}>{state.message}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Retry project workspace" onPress={() => void hydrate()} style={styles.retryButton}>
          <Text style={styles.retryButtonText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  const { summary, workspace, selection, refreshing, loadingMore, warning } = state.value;
  const offline = connectionState !== "connected";
  const tablet = width >= 768;
  const canShowKanban = kanbanViewEnabled(summary);
  const canCreateConversations = runtimeCapabilityEnabled(summary, "codingAgentsThreadCreate");
  const canLoadMore = workspaceHasNextPage(workspace);

  const loadMore = async () => {
    const current = stateRef.current;
    if (!client || current.status !== "ready" || current.value.loadingMore) return;
    const options = nextWorkspacePageOptions(current.value.workspace);
    if (!options) return;
    const generation = generationRef.current;
    setState({
      status: "ready",
      value: { ...current.value, loadingMore: true, warning: null },
    });
    const result = await client.getCodingAgentProjectWorkspace(options);
    if (generation !== generationRef.current) return;
    const latest = stateRef.current;
    if (
      latest.status !== "ready"
      || !result.ok
      || result.workspace.project.id !== latest.value.workspace.project.id
    ) {
      setHydrationFailure(
        generationRef,
        generation,
        latest.status === "ready" ? latest.value : null,
        setState,
      );
      return;
    }
    setState({
      status: "ready",
      value: {
        ...latest.value,
        workspace: mergeWorkspacePage(latest.value.workspace, result.workspace, options),
        loadingMore: false,
      },
    });
  };

  const openProject = (projectId: string) => {
    const nextSelection = {
      ...selectAgentWorkspaceProject(selection, summary, projectId),
      updatedAt: new Date().toISOString(),
    };
    setState({ status: "ready", value: { ...state.value, selection: nextSelection } });
    void persistSelection(nextSelection);
    onOpenProject(projectId);
  };

  const openThread = (thread: AgentThreadSummary) => {
    const nextSelection = {
      ...selectAgentWorkspaceThread(selection, workspace, thread.id),
      updatedAt: new Date().toISOString(),
    };
    setState({ status: "ready", value: { ...state.value, selection: nextSelection } });
    void persistSelection(nextSelection);
    onOpenThread({
      projectId: workspace.project.id,
      taskId: nextSelection.selectedTaskId,
      threadId: thread.id,
    });
  };

  const changeViewMode = (viewMode: AgentWorkspaceViewMode) => {
    if (viewMode === "kanban" && !canShowKanban) return;
    const nextSelection = {
      ...selectAgentWorkspaceViewMode(selection, viewMode),
      updatedAt: new Date().toISOString(),
    };
    setState({ status: "ready", value: { ...state.value, selection: nextSelection } });
    void persistSelection(nextSelection);
    onViewModeChange?.(viewMode);
  };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void hydrate()} tintColor={theme.colors.forest} />}
      contentContainerStyle={[
        styles.content,
        { paddingBottom: contentBottomInset },
        tablet ? styles.tabletContent : null,
      ]}
    >
      {offline ? (
        <View accessibilityRole="alert" style={styles.offlineBanner}>
          <Text selectable style={styles.offlineText}>Workspace offline. Showing the last refreshed project.</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Retry project workspace" onPress={() => client?.connect()} style={styles.bannerButton}>
            <Text style={styles.bannerButtonText}>Retry</Text>
          </Pressable>
        </View>
      ) : null}
      {warning ? <Text selectable style={styles.warningText}>{warning}</Text> : null}

      <View style={styles.projectHeader}>
        <View style={styles.projectHeaderText}>
          <Text selectable style={styles.heading}>{workspace.project.label}</Text>
          <Text selectable style={styles.subheading}>
            {selection.viewMode === "kanban" ? "Tasks by canonical status" : "Conversations by project and task"}
          </Text>
        </View>
        {canCreateConversations ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="New project conversation"
            onPress={() => onNewConversation({ projectId: workspace.project.id, taskId: null })}
            style={styles.primaryButton}
          >
            <Ionicons name="add" size={17} color={theme.colors.primaryForeground} />
            <Text style={styles.primaryButtonText}>New chat</Text>
          </Pressable>
        ) : null}
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.projectSelector}>
        {summary.projects.items.map((project) => {
          const selected = project.id === workspace.project.id;
          return (
            <Pressable
              key={project.id}
              accessibilityRole="button"
              accessibilityLabel={`Open project ${project.label}`}
              accessibilityState={{ selected }}
              onPress={() => openProject(project.id)}
              style={[styles.projectPill, selected ? styles.projectPillSelected : null]}
            >
              <Text style={[styles.projectPillText, selected ? styles.projectPillTextSelected : null]}>{project.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {canShowKanban ? (
        <AgentProjectViewModeControl viewMode={selection.viewMode} onChange={changeViewMode} />
      ) : null}

      {selection.viewMode === "kanban" && canShowKanban ? (
        <AgentProjectKanban
          workspace={workspace}
          tablet={tablet}
          canCreateConversations={canCreateConversations}
          onOpenThread={openThread}
          onNewConversation={(taskId) => onNewConversation({ projectId: workspace.project.id, taskId })}
        />
      ) : (
        <AgentProjectConversation
          workspace={workspace}
          canCreateConversations={canCreateConversations}
          onOpenThread={openThread}
          onNewConversation={(taskId) => onNewConversation({ projectId: workspace.project.id, taskId })}
        />
      )}

      {canLoadMore ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Load more project workspace"
          accessibilityState={{ busy: loadingMore, disabled: loadingMore }}
          disabled={loadingMore}
          onPress={() => void loadMore()}
          style={styles.retryButton}
        >
          {loadingMore ? (
            <ActivityIndicator color={theme.colors.primaryForeground} />
          ) : (
            <Text style={styles.retryButtonText}>Load more</Text>
          )}
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

function projectWorkspaceCapabilitiesEnabled(summary: RuntimeSummary): boolean {
  return runtimeCapabilityEnabled(summary, "codingAgentsProjectWorkspace")
    && runtimeCapabilityEnabled(summary, "codingAgentsConversationView");
}

function kanbanViewEnabled(summary: RuntimeSummary): boolean {
  return runtimeCapabilityEnabled(summary, "codingAgentsKanbanView");
}

function setHydrationFailure(
  generationRef: React.MutableRefObject<number>,
  generation: number,
  retained: ReadyWorkspaceState | null,
  setState: React.Dispatch<React.SetStateAction<ProjectScreenState>>,
  message = PROJECT_WORKSPACE_ERROR,
) {
  if (generation !== generationRef.current) return;
  if (retained) {
    setState({
      status: "ready",
      value: { ...retained, refreshing: false, loadingMore: false, warning: message },
    });
    return;
  }
  setState({ status: "error", message });
}

async function persistSelection(selection: AgentWorkspaceState): Promise<void> {
  try {
    await saveAgentWorkspaceState(selection);
  } catch (error: unknown) {
    console.warn("[mobile] agent workspace selection could not be saved", {
      name: error instanceof Error ? error.name : "Unknown",
    });
  }
}

function workspaceHasNextPage(workspace: ProjectAgentWorkspace): boolean {
  return Boolean(
    (workspace.tasks.hasMore && workspace.tasks.nextCursor)
    || (workspace.projectThreads.hasMore && workspace.projectThreads.nextCursor)
    || (workspace.taskThreads.hasMore && workspace.taskThreads.nextCursor),
  );
}

function nextWorkspacePageOptions(
  workspace: ProjectAgentWorkspace,
): CodingAgentProjectWorkspaceOptions | null {
  const options: CodingAgentProjectWorkspaceOptions = { projectId: workspace.project.id };
  if (workspace.tasks.hasMore && workspace.tasks.nextCursor) {
    options.taskCursor = workspace.tasks.nextCursor;
    options.taskLimit = workspace.tasks.limit;
  }
  if (workspace.projectThreads.hasMore && workspace.projectThreads.nextCursor) {
    options.projectThreadCursor = workspace.projectThreads.nextCursor;
    options.projectThreadLimit = workspace.projectThreads.limit;
  }
  if (workspace.taskThreads.hasMore && workspace.taskThreads.nextCursor) {
    options.taskThreadCursor = workspace.taskThreads.nextCursor;
    options.taskThreadLimit = workspace.taskThreads.limit;
  }
  return Object.keys(options).length > 1 ? options : null;
}

function mergeWorkspacePage(
  current: ProjectAgentWorkspace,
  page: ProjectAgentWorkspace,
  options: CodingAgentProjectWorkspaceOptions,
): ProjectAgentWorkspace {
  return {
    ...current,
    project: page.project,
    tasks: options.taskCursor ? mergeWorkspaceList(current.tasks, page.tasks) : current.tasks,
    projectThreads: options.projectThreadCursor
      ? mergeWorkspaceList(current.projectThreads, page.projectThreads)
      : current.projectThreads,
    taskThreads: options.taskThreadCursor
      ? mergeWorkspaceList(current.taskThreads, page.taskThreads)
      : current.taskThreads,
    updatedAt: page.updatedAt,
  };
}

function mergeWorkspaceList<T extends { id: string }>(
  current: { items: T[]; hasMore: boolean; nextCursor?: string; limit: number },
  page: { items: T[]; hasMore: boolean; nextCursor?: string; limit: number },
) {
  const byId = new Map(current.items.map((item) => [item.id, item]));
  for (const item of page.items) byId.set(item.id, item);
  const items = [...byId.values()].slice(0, MAX_ACCUMULATED_WORKSPACE_ITEMS);
  const hasMore = page.hasMore && items.length < MAX_ACCUMULATED_WORKSPACE_ITEMS;
  return {
    items,
    hasMore,
    ...(hasMore && page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    limit: page.limit,
  };
}
