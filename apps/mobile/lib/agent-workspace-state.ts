import AsyncStorage from "@react-native-async-storage/async-storage";

export const AGENT_WORKSPACE_STATE_STORAGE_KEY = "matrix.agentWorkspaceState.v1";

export interface AgentWorkspaceState {
  selectedThreadId: string | null;
  selectedTerminalSessionId: string | null;
  updatedAt: string | null;
}

type AgentWorkspaceStorage = Pick<typeof AsyncStorage, "getItem" | "setItem">;

const SAFE_THREAD_ID = /^thread_[A-Za-z0-9_-]{1,128}$/;
const SAFE_TERMINAL_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export function parseAgentWorkspaceState(value: unknown): AgentWorkspaceState {
  if (!value || typeof value !== "object") {
    return createEmptyAgentWorkspaceState();
  }
  const record = value as Record<string, unknown>;
  return {
    selectedThreadId: safeThreadId(record.selectedThreadId),
    selectedTerminalSessionId: safeTerminalSessionId(record.selectedTerminalSessionId),
    updatedAt: safeIsoTimestamp(record.updatedAt),
  };
}

export function reconcileAgentWorkspaceState(
  state: AgentWorkspaceState,
  summary: {
    activeThreads?: { items?: Array<{ id?: unknown }> };
    attentionThreads?: { items?: Array<{ id?: unknown }> };
    terminalSessions?: { items?: Array<{ id?: unknown }> };
  },
): AgentWorkspaceState {
  const threadIds = new Set(
    [
      ...(summary.activeThreads?.items ?? []),
      ...(summary.attentionThreads?.items ?? []),
    ]
      .map((thread) => thread.id)
      .filter((id): id is string => typeof id === "string"),
  );
  const terminalIds = new Set(
    (summary.terminalSessions?.items ?? [])
      .map((session) => session.id)
      .filter((id): id is string => typeof id === "string"),
  );
  return {
    ...state,
    selectedThreadId: state.selectedThreadId && threadIds.has(state.selectedThreadId) ? state.selectedThreadId : null,
    selectedTerminalSessionId:
      state.selectedTerminalSessionId && terminalIds.has(state.selectedTerminalSessionId)
        ? state.selectedTerminalSessionId
        : null,
  };
}

export async function loadAgentWorkspaceState(
  storage: AgentWorkspaceStorage = AsyncStorage,
): Promise<AgentWorkspaceState> {
  try {
    const raw = await storage.getItem(AGENT_WORKSPACE_STATE_STORAGE_KEY);
    if (!raw) return createEmptyAgentWorkspaceState();
    return parseAgentWorkspaceState(JSON.parse(raw));
  } catch (err) {
    console.warn("[mobile] failed to load agent workspace state", err);
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

function createEmptyAgentWorkspaceState(): AgentWorkspaceState {
  return {
    selectedThreadId: null,
    selectedTerminalSessionId: null,
    updatedAt: null,
  };
}

function safeThreadId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const threadId = value.trim();
  return SAFE_THREAD_ID.test(threadId) ? threadId : null;
}

function safeTerminalSessionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const sessionId = value.trim();
  if (sessionId.includes("..")) return null;
  return SAFE_TERMINAL_SESSION_ID.test(sessionId) ? sessionId : null;
}

function safeIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}
