import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  IsoTimestampSchema,
  ProjectIdSchema,
  RuntimeIdSchema,
  TaskIdSchema,
  ThreadIdSchema,
  type ProjectAgentWorkspace,
  type RuntimeSummary,
} from "@matrix-os/contracts";
import { z } from "zod/v4";

export const AGENT_WORKSPACE_STATE_STORAGE_KEY = "matrix.agentWorkspaceState.v2";

export const AgentWorkspaceViewModeSchema = z.enum(["conversation", "kanban"]);
export type AgentWorkspaceViewMode = z.infer<typeof AgentWorkspaceViewModeSchema>;

export interface AgentWorkspaceState {
  selectedRuntimeId: string | null;
  selectedProjectId: string | null;
  selectedTaskId: string | null;
  selectedThreadId: string | null;
  viewMode: AgentWorkspaceViewMode;
  updatedAt: string | null;
}

type AgentWorkspaceStorage = Pick<typeof AsyncStorage, "getItem" | "setItem">;

export function createEmptyAgentWorkspaceState(): AgentWorkspaceState {
  return {
    selectedRuntimeId: null,
    selectedProjectId: null,
    selectedTaskId: null,
    selectedThreadId: null,
    viewMode: "conversation",
    updatedAt: null,
  };
}

export function parseAgentWorkspaceState(value: unknown): AgentWorkspaceState {
  if (!value || typeof value !== "object") {
    return createEmptyAgentWorkspaceState();
  }
  const record = value as Record<string, unknown>;
  return {
    selectedRuntimeId: parseNullableReference(RuntimeIdSchema, record.selectedRuntimeId),
    selectedProjectId: parseNullableReference(ProjectIdSchema, record.selectedProjectId),
    selectedTaskId: parseNullableReference(TaskIdSchema, record.selectedTaskId),
    selectedThreadId: parseNullableReference(ThreadIdSchema, record.selectedThreadId),
    viewMode: AgentWorkspaceViewModeSchema.catch("conversation").parse(record.viewMode),
    updatedAt: parseNullableReference(IsoTimestampSchema, record.updatedAt),
  };
}

export async function loadAgentWorkspaceState(
  storage: AgentWorkspaceStorage = AsyncStorage,
): Promise<AgentWorkspaceState> {
  try {
    const raw = await storage.getItem(AGENT_WORKSPACE_STATE_STORAGE_KEY);
    if (!raw) return createEmptyAgentWorkspaceState();
    return parseAgentWorkspaceState(JSON.parse(raw));
  } catch (error: unknown) {
    console.warn("[mobile] agent workspace selection could not be restored", safeStorageError(error));
    return createEmptyAgentWorkspaceState();
  }
}

export async function saveAgentWorkspaceState(
  state: AgentWorkspaceState,
  storage: AgentWorkspaceStorage = AsyncStorage,
): Promise<void> {
  const safeState = parseAgentWorkspaceState(state);
  await storage.setItem(AGENT_WORKSPACE_STATE_STORAGE_KEY, JSON.stringify(safeState));
}

export function reconcileAgentWorkspaceState(
  state: AgentWorkspaceState,
  summary: RuntimeSummary,
  workspace?: ProjectAgentWorkspace,
): AgentWorkspaceState {
  const runtimeChanged = state.selectedRuntimeId !== null
    && state.selectedRuntimeId !== summary.runtime.id;
  const liveProject = !runtimeChanged
    ? summary.projects.items.find((project) => project.id === state.selectedProjectId)
    : undefined;
  const selectedProjectId = liveProject?.id ?? summary.projects.items[0]?.id ?? null;

  const base: AgentWorkspaceState = {
    ...state,
    selectedRuntimeId: summary.runtime.id,
    selectedProjectId,
    selectedTaskId: runtimeChanged ? null : state.selectedTaskId,
    selectedThreadId: runtimeChanged ? null : state.selectedThreadId,
  };

  if (!workspace || workspace.project.id !== selectedProjectId) {
    return {
      ...base,
      selectedTaskId: null,
      selectedThreadId: null,
    };
  }

  const selectedThread = allWorkspaceThreads(workspace)
    .find((thread) => thread.id === base.selectedThreadId);
  if (selectedThread) {
    return {
      ...base,
      selectedTaskId: selectedThread.taskId ?? null,
      selectedThreadId: selectedThread.id,
    };
  }

  const selectedTaskId = workspace.tasks.items.some((task) => task.id === base.selectedTaskId)
    ? base.selectedTaskId
    : null;
  return {
    ...base,
    selectedTaskId,
    selectedThreadId: null,
  };
}

export function selectAgentWorkspaceThread(
  state: AgentWorkspaceState,
  workspace: ProjectAgentWorkspace,
  threadId: string,
): AgentWorkspaceState {
  const parsedThreadId = ThreadIdSchema.safeParse(threadId);
  if (!parsedThreadId.success) return state;
  const selectedThread = allWorkspaceThreads(workspace)
    .find((thread) => thread.id === parsedThreadId.data);
  if (!selectedThread) return state;
  return {
    ...state,
    selectedProjectId: workspace.project.id,
    selectedTaskId: selectedThread.taskId ?? null,
    selectedThreadId: selectedThread.id,
    viewMode: "conversation",
  };
}

export function selectAgentWorkspaceProject(
  state: AgentWorkspaceState,
  summary: RuntimeSummary,
  projectId: string,
): AgentWorkspaceState {
  const parsedProjectId = ProjectIdSchema.safeParse(projectId);
  if (!parsedProjectId.success) return state;
  if (!summary.projects.items.some((project) => project.id === parsedProjectId.data)) return state;
  if (state.selectedProjectId === parsedProjectId.data) return state;
  return {
    ...state,
    selectedRuntimeId: summary.runtime.id,
    selectedProjectId: parsedProjectId.data,
    selectedTaskId: null,
    selectedThreadId: null,
  };
}

export function selectAgentWorkspaceViewMode(
  state: AgentWorkspaceState,
  viewMode: AgentWorkspaceViewMode,
): AgentWorkspaceState {
  return {
    ...state,
    viewMode: AgentWorkspaceViewModeSchema.parse(viewMode),
  };
}

function allWorkspaceThreads(workspace: ProjectAgentWorkspace) {
  return [...workspace.projectThreads.items, ...workspace.taskThreads.items];
}

function parseNullableReference<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function safeStorageError(error: unknown): { name: string } {
  return { name: error instanceof Error ? error.name : "Unknown" };
}
