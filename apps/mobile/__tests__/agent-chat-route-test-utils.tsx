import type { ReactNode } from "react";

// Shared by the suites that render the agent chat route. Each suite mocks the
// modules itself (jest.mock is per file) and points them here.

export const router = {
  back: jest.fn(),
  push: jest.fn(),
  replace: jest.fn(),
  dismissAll: jest.fn(),
  canDismiss: jest.fn(() => true),
  canGoBack: jest.fn(() => true),
};

/** What the screen reaches outside itself. */
export const shell = {
  selectChat: jest.fn(),
  startDraftChat: jest.fn(),
  bindDraftChatId: jest.fn(),
  sync: jest.fn(),
  ensure: jest.fn(),
  archive: jest.fn(),
  refetchAgents: jest.fn(() => Promise.resolve()),
  sendMessage: jest.fn(),
  cancelRun: jest.fn(),
};

/** The actions on an agent's status. */
export const bot = {
  resolve: jest.fn(),
  refresh: jest.fn(),
  revoke: jest.fn(),
  memory: jest.fn(),
  updateModel: jest.fn(),
};

export const managed = { instanceId: "matrix_pi_default", model: "sonnet" };

export const catalog = {
  instances: [{
    id: "matrix_pi_default", driverKind: "matrix_pi", displayName: "Pi", connectionLabel: "Matrix AI",
    availability: "available",
    models: [{ id: "sonnet", displayName: "Claude Sonnet 5", availability: "available" }],
    supports: { interactionModes: ["default"], permissionModes: ["supervised"] },
  }],
};

/** An agent made from a template. */
export const research = {
  id: "bot_research1", name: "Account research", description: "Briefs you before every sales call",
  instructions: "", selection: { instanceId: "matrix_bot_default", model: "auto" },
  recipeRef: { recipeId: "account-research", version: "v2" }, revision: 7, archived: false,
};

/** An agent of the person's own: no template, so no status to read. */
export const custom = {
  id: "bot_custom001", name: "Release notes", description: "Writes the release notes",
  instructions: "", selection: managed, revision: 2, archived: false,
};

export const customStatuses = {
  bot_custom001: { state: "unavailable", label: "Status unavailable", chatId: "chat_custom", lastActivityAt: null },
};

export const approval = {
  interactionId: "in_abcdefgh", chatId: "chat_research", agentId: "bot_research1", taskId: "task_abcdefgh",
  kind: "approval", blocking: true, status: "pending", expiresAt: "2099-01-01T00:00:00.000Z", revision: 3,
  payload: { kind: "approval", tool: "integration.call", argsDigest: "a".repeat(64),
    account: { service: "slack", label: "#northwind-deal" }, audience: "direct",
    preview: "Brief for today's Northwind call.", policyRevision: 1 },
};

export function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "bot_research1", name: "Account research", selection: research.selection, revision: 7,
    interactions: [], tasks: [],
    authority: { agentId: "bot_research1", revision: 1, grants: [],
      connections: [{ service: "google_drive", state: "granted" }],
      routines: [], pendingInteractions: [], memory: { items: [] } },
    ...overrides,
  };
}

export function chatDetail(overrides: Record<string, unknown> = {}) {
  return {
    record: { projectId: null, chat: { id: "chat_research", title: "Account research", revision: 4 } },
    runs: [], turns: [], activities: [],
    messages: [{ id: "msg_reply", chatId: "chat_research", role: "assistant", state: "committed", seq: 1,
      parts: [{ type: "text", text: "Brief ready for your call." }], createdAt: "2026-09-09T00:00:01.000Z" }],
    ...overrides,
  };
}

export const runningRun = { id: "run_live", turnId: "cturn_2", status: "running", selection: { model: "auto" },
  createdAt: "2026-09-09T00:01:00.000Z", startedAt: "2026-09-09T00:01:00.000Z" };

/** What the mocked hooks answer with. `reset` puts it back before each test. */
export const state = {
  agentId: "bot_research1",
  agents: [] as unknown[],
  statuses: {} as Record<string, unknown>,
  ensure: { isError: false } as { data?: string; variables?: string; isError: boolean },
  archivePending: false,
  detail: undefined as unknown,
  botSnapshot: null as unknown,
  botError: false,
  /** Every chat id the chat's detail and the agent's status were read for. */
  detailChatIds: [] as (string | null)[],
  botChatIds: [] as (string | null)[],
};

/** What the native sheet was last given. */
export const sheet = {
  isPresented: false,
  onDismiss: (() => {}) as () => void,
};

export function reset() {
  jest.clearAllMocks();
  router.canDismiss.mockReturnValue(true);
  router.canGoBack.mockReturnValue(true);
  state.agentId = "bot_research1";
  state.agents = [research, custom];
  state.statuses = {
    bot_research1: { state: "attention", label: "Approval requested", chatId: "chat_research", lastActivityAt: null },
    bot_custom001: { state: "unavailable", label: "Status unavailable", chatId: null, lastActivityAt: null },
  };
  state.ensure = { isError: false };
  state.archivePending = false;
  state.detail = chatDetail();
  state.botSnapshot = snapshot();
  state.botError = false;
  state.detailChatIds.length = 0;
  state.botChatIds.length = 0;
  sheet.isPresented = false;
  sheet.onDismiss = () => {};
  bot.resolve.mockResolvedValue({ interaction: { interactionId: "in_abcdefgh", status: "resolved", revision: 4 } });
  bot.refresh.mockResolvedValue(undefined);
  bot.updateModel.mockResolvedValue(undefined);
}

/** Stands in for `@expo/ui`: a sheet whose content is there only while it is presented. */
export function sheetModule() {
  const { View } = jest.requireActual("react-native") as typeof import("react-native");
  return {
    BottomSheet: (props: { children: ReactNode; isPresented: boolean; onDismiss: () => void }) => {
      sheet.isPresented = props.isPresented;
      sheet.onDismiss = props.onDismiss;
      return props.isPresented ? <View testID="expo-bottom-sheet">{props.children}</View> : null;
    },
    RNHostView: ({ children }: { children: ReactNode }) => children,
  };
}

export function expoRouterModule() {
  return {
    useLocalSearchParams: () => ({ agentId: state.agentId }),
    useRouter: () => router,
  };
}

export function sessionModule() {
  return {
    useCanonicalChatSession: () => ({
      // Whatever the Chats tab has open: a chat of the person's own.
      activeChatId: "chat_habits",
      selectChat: shell.selectChat,
      startDraftChat: shell.startDraftChat,
      bindDraftChatId: shell.bindDraftChatId,
      subscribe: () => () => {},
      streamLive: true,
    }),
  };
}

export function agentsModule() {
  return {
    useAgents: () => ({
      agents: state.agents, agentsEnabled: true, isPending: false, isError: false, refetch: shell.refetchAgents,
    }),
    useEnsureAgentChat: () => ({ mutate: shell.ensure, ...state.ensure }),
    useArchiveAgent: () => ({ mutateAsync: shell.archive, isPending: state.archivePending }),
  };
}

export function agentStatusesModule() {
  return {
    useAgentStatuses: () => ({ statuses: state.statuses, waitingCount: 0, isPending: false, refetch: jest.fn() }),
  };
}

export function chatDetailModule() {
  return {
    useCanonicalChatDetail: (chatId: string | null) => {
      state.detailChatIds.push(chatId);
      return {
        detail: chatId ? state.detail : null,
        computer: { handle: "amin", runtimeSlot: "primary", gatewayPath: "/vm/amin" },
        refresh: jest.fn(),
      };
    },
  };
}

export function botChatModule() {
  return {
    useBotChat: (chatId: string | null) => {
      state.botChatIds.push(chatId);
      return { snapshot: chatId ? state.botSnapshot : null, isError: state.botError, ...bot };
    },
  };
}
