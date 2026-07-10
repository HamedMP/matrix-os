import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  useWindowDimensions,
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
import type { ConnectionState, GatewayClient } from "@/lib/gateway-client";
import {
  loadAgentWorkspaceState,
  reconcileAgentWorkspaceState,
  saveAgentWorkspaceState,
  selectAgentWorkspaceProject,
  selectAgentWorkspaceThread,
  type AgentWorkspaceState,
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
  warning: string | null;
}

type ProjectScreenState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; value: ReadyWorkspaceState };

interface AgentProjectWorkspaceScreenProps {
  client: ProjectWorkspaceClient | null;
  connectionState: ConnectionState;
  requestedProjectId: string;
  onOpenProject: (projectId: string) => void;
  onOpenThread: (identity: AgentConversationIdentity) => void;
  onNewConversation: (identity: { projectId: string; taskId: string | null }) => void;
}

const PROJECT_WORKSPACE_ERROR = "Project workspace unavailable. Refresh or choose another project.";

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
}: AgentProjectWorkspaceScreenProps) {
  const { theme } = useUnistyles();
  const { width } = useWindowDimensions();
  const [state, setState] = useState<ProjectScreenState>({ status: "loading" });
  const generationRef = useRef(0);
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
      setState({ status: "ready", value: { ...retained, refreshing: true, warning: null } });
    } else {
      setState({ status: "loading" });
    }

    if (!client) {
      setHydrationFailure(generationRef, generation, retained, setState);
      return;
    }
    const parsedRequestedProject = ProjectIdSchema.safeParse(requestedProjectId);
    if (!parsedRequestedProject.success) {
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

    let selection = reconcileAgentWorkspaceState(restored, summaryResult.summary);
    const requestedExists = summaryResult.summary.projects.items.some(
      (project) => project.id === parsedRequestedProject.data,
    );
    if (requestedExists) {
      selection = selectAgentWorkspaceProject(
        selection,
        summaryResult.summary,
        parsedRequestedProject.data,
      );
    }
    const selectedProjectId = selection.selectedProjectId;
    if (!selectedProjectId) {
      setHydrationFailure(generationRef, generation, retained, setState, "No coding projects are available.");
      return;
    }

    const workspaceResult = await client.getCodingAgentProjectWorkspace({ projectId: selectedProjectId });
    if (generation !== generationRef.current) return;
    if (!workspaceResult.ok || workspaceResult.workspace.project.id !== selectedProjectId) {
      setHydrationFailure(generationRef, generation, retained, setState);
      return;
    }

    selection = {
      ...reconcileAgentWorkspaceState(selection, summaryResult.summary, workspaceResult.workspace),
      updatedAt: new Date().toISOString(),
    };
    await persistSelection(selection);
    if (generation !== generationRef.current) return;
    setState({
      status: "ready",
      value: {
        summary: summaryResult.summary,
        workspace: workspaceResult.workspace,
        selection,
        refreshing: false,
        warning: requestedExists ? null : "The previous project was unavailable. Showing a live project instead.",
      },
    });
    if (!requestedExists && selectedProjectId !== requestedProjectId) {
      onOpenProject(selectedProjectId);
    }
  }, [client, onOpenProject, requestedProjectId]);

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

  const { summary, workspace, selection, refreshing, warning } = state.value;
  const offline = connectionState !== "connected";
  const tablet = width >= 768;

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
      taskId: thread.taskId ?? null,
      threadId: thread.id,
    });
  };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void hydrate()} tintColor={theme.colors.forest} />}
      contentContainerStyle={[styles.content, tablet ? styles.tabletContent : null]}
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
          <Text selectable style={styles.subheading}>Conversations by project and task</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New project conversation"
          onPress={() => onNewConversation({ projectId: workspace.project.id, taskId: null })}
          style={styles.primaryButton}
        >
          <Ionicons name="add" size={17} color={theme.colors.primaryForeground} />
          <Text style={styles.primaryButtonText}>New chat</Text>
        </Pressable>
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

      <ConversationSection title="Project chats" count={workspace.projectThreads.items.length}>
        {workspace.projectThreads.items.length === 0 ? (
          <Text selectable style={styles.emptyText}>No project-level conversations yet.</Text>
        ) : null}
        {workspace.projectThreads.items.map((thread) => (
          <ConversationRow key={thread.id} thread={thread} onPress={() => openThread(thread)} />
        ))}
      </ConversationSection>

      <View style={styles.taskList}>
        <Text selectable style={styles.sectionHeading}>Tasks</Text>
        {workspace.tasks.items.length === 0 ? (
          <Text selectable style={styles.emptyText}>No tasks are available in this project.</Text>
        ) : null}
        {workspace.tasks.items.map((task) => {
          const threads = taskThreads(workspace, task.id);
          return (
            <View
              key={task.id}
              accessible
              accessibilityLabel={`${task.title}, ${countLabel(task.threadCount, "conversation")}`}
              style={styles.taskCard}
            >
              <View style={styles.taskHeader}>
                <View style={styles.taskHeaderText}>
                  <Text selectable style={styles.rowTitle}>{task.title}</Text>
                  <Text selectable style={styles.rowSubtitle}>
                    {countLabel(task.threadCount, "conversation")} · {task.status.replace(/_/g, " ")}
                  </Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`New conversation for ${task.title}`}
                  onPress={() => onNewConversation({ projectId: workspace.project.id, taskId: task.id })}
                  style={styles.secondaryButton}
                >
                  <Ionicons name="add" size={16} color={theme.colors.forest} />
                </Pressable>
              </View>
              {threads.length === 0 ? (
                <Text selectable style={styles.emptyText}>No conversations for this task.</Text>
              ) : null}
              {threads.map((thread) => (
                <ConversationRow key={thread.id} thread={thread} onPress={() => openThread(thread)} />
              ))}
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
}

export function taskThreads(workspace: ProjectAgentWorkspace, taskId: string): AgentThreadSummary[] {
  return workspace.taskThreads.items.filter((thread) => thread.taskId === taskId);
}

function ConversationSection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionTitleRow}>
        <Text selectable style={styles.sectionHeading}>{title}</Text>
        <Text selectable style={styles.countText}>{count}</Text>
      </View>
      {children}
    </View>
  );
}

function ConversationRow({ thread, onPress }: { thread: AgentThreadSummary; onPress: () => void }) {
  const { theme } = useUnistyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open conversation ${thread.title}`}
      onPress={onPress}
      style={({ pressed }) => [styles.threadRow, pressed ? styles.pressed : null]}
    >
      <View style={styles.threadIcon}>
        <Ionicons name="chatbubble-ellipses-outline" size={17} color={theme.colors.moss} />
      </View>
      <View style={styles.threadText}>
        <Text selectable numberOfLines={1} style={styles.rowTitle}>{thread.title}</Text>
        <Text selectable style={styles.rowSubtitle}>{thread.providerId} · {thread.status.replace(/_/g, " ")}</Text>
      </View>
      {thread.attention && thread.attention !== "none" ? (
        <View style={styles.attentionDot} />
      ) : null}
      <Ionicons name="chevron-forward" size={17} color={theme.colors.mutedForeground} />
    </Pressable>
  );
}

function projectWorkspaceCapabilitiesEnabled(summary: RuntimeSummary): boolean {
  const enabled = (id: "codingAgentsProjectWorkspace" | "codingAgentsConversationView") =>
    summary.capabilities.some((capability) => capability.id === id && capability.enabled);
  return enabled("codingAgentsProjectWorkspace") && enabled("codingAgentsConversationView");
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
      value: { ...retained, refreshing: false, warning: message },
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

function countLabel(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}
