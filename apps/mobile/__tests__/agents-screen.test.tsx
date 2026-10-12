import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import { Alert } from "react-native";

import AgentsScreen from "../app/(drawer)/(tabs)/agents/index";
import { StatusDot } from "../components/ui/StatusDot";

const mockSelectChat = jest.fn();
const mockShowChatScreen = jest.fn();
const mockPush = jest.fn();
const mockEnsureChat = jest.fn();
const mockRefetchAgents = jest.fn(() => Promise.resolve());
const mockRefetchStatuses = jest.fn(() => Promise.resolve());
const mockUseAgents = jest.fn();
const mockUseAgentStatuses = jest.fn();
let mockChats: unknown[] = [];
let mockGainFocus: () => void = () => {};

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
  useFocusEffect: (effect: () => void) => {
    const mockReact = jest.requireActual("react") as typeof import("react");
    mockReact.useEffect(() => {
      mockGainFocus = effect;
      effect();
    }, [effect]);
  },
}));
jest.mock("@/lib/canonical-chat-session-context", () => ({
  useCanonicalChatSession: () => ({ selectChat: mockSelectChat }),
}));
jest.mock("@/lib/queries/use-agents", () => ({
  useAgents: () => mockUseAgents(),
  useEnsureAgentChat: () => ({ mutateAsync: mockEnsureChat }),
}));
jest.mock("@/lib/queries/use-agent-statuses", () => ({
  useAgentStatuses: (...args: unknown[]) => mockUseAgentStatuses(...args),
}));
jest.mock("@/lib/queries/use-canonical-chats", () => ({
  useCanonicalChats: () => ({ chats: mockChats }),
}));
jest.mock("@/lib/use-shell-navigation", () => ({ useShowChatScreen: () => mockShowChatScreen }));

const research = { id: "bot_research", name: "Account research", description: "Briefs you before every sales call" };
const inbox = { id: "bot_inbox", name: "My inbox", description: "Sorts your inbox" };
const launch = { id: "bot_launch", name: "Launch tracker", description: "Keeps the launch on track" };
const agents = [research, inbox, launch];

function agentsResult(overrides: Record<string, unknown> = {}) {
  return {
    agents,
    agentsEnabled: true,
    isPending: false,
    isError: false,
    refetch: mockRefetchAgents,
    ...overrides,
  };
}

const statuses = {
  bot_research: { state: "attention", label: "Waiting for your approval", chatId: "chat_research", lastActivityAt: null },
  bot_inbox: { state: "working", label: "Working", chatId: "chat_inbox", lastActivityAt: null },
  bot_launch: { state: "idle", label: "No open tasks", chatId: null, lastActivityAt: null },
};

describe("agents tab root", () => {
  let alert: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    mockUseAgents.mockReturnValue(agentsResult());
    mockUseAgentStatuses.mockReturnValue({ statuses, waitingCount: 1, isPending: false, refetch: mockRefetchStatuses });
    mockChats = [
      { chat: { id: "chat_research", activityAt: new Date(Date.now() - 2 * 60_000).toISOString(), updatedAt: "2026-01-01T00:00:00.000Z" } },
    ];
  });

  afterEach(() => {
    cleanup();
    alert.mockRestore();
  });

  it("reads the statuses of the saved agents", () => {
    render(<AgentsScreen />);

    expect(mockUseAgentStatuses).toHaveBeenCalledWith(agents);
  });

  it("lists each agent with its status dot, status line and last chat activity", () => {
    render(<AgentsScreen />);

    const waiting = screen.getByTestId("agent-row-bot_research");
    expect(within(waiting).getByText("Account research")).toBeTruthy();
    expect(within(waiting).getByText("Waiting for your approval")).toBeTruthy();
    expect(within(waiting).UNSAFE_getByType(StatusDot).props.tone).toBe("waiting");
    expect(within(waiting).getByText("2m")).toBeTruthy();

    const working = screen.getByTestId("agent-row-bot_inbox");
    expect(within(working).getByText("Working")).toBeTruthy();
    expect(within(working).UNSAFE_getByType(StatusDot).props.tone).toBe("active");
  });

  it("shows an idle agent's description instead of its status, with no dot and no time", () => {
    render(<AgentsScreen />);

    const idle = screen.getByTestId("agent-row-bot_launch");
    expect(within(idle).getByText("Keeps the launch on track")).toBeTruthy();
    expect(within(idle).queryByText("No open tasks")).toBeNull();
    expect(within(idle).UNSAFE_queryByType(StatusDot)).toBeNull();
  });

  it("opens New agent from the header", () => {
    render(<AgentsScreen />);

    fireEvent.press(screen.getByTestId("agents-new"));

    expect(mockPush).toHaveBeenCalledWith("/agents/new");
  });

  it("opens the agent's own chat screen, leaving the Chats tab and its open chat alone", () => {
    render(<AgentsScreen />);

    fireEvent.press(screen.getByTestId("agent-row-bot_launch"));

    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith({ pathname: "/agents/[agentId]", params: { agentId: "bot_launch" } });
    expect(mockSelectChat).not.toHaveBeenCalled();
    expect(mockShowChatScreen).not.toHaveBeenCalled();
    // The agent's screen finds the chat itself.
    expect(mockEnsureChat).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });

  it("opens one screen only, however often rows are pressed, until the list is shown again", () => {
    render(<AgentsScreen />);

    fireEvent.press(screen.getByTestId("agent-row-bot_launch"));
    fireEvent.press(screen.getByTestId("agent-row-bot_launch"));
    fireEvent.press(screen.getByTestId("agent-row-bot_inbox"));
    expect(mockPush).toHaveBeenCalledTimes(1);

    act(() => mockGainFocus());
    fireEvent.press(screen.getByTestId("agent-row-bot_inbox"));

    expect(mockPush).toHaveBeenCalledTimes(2);
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: "/agents/[agentId]", params: { agentId: "bot_inbox" } });
  });

  it("leaves the first read to the queries when the screen is first shown", () => {
    render(<AgentsScreen />);

    expect(mockRefetchAgents).not.toHaveBeenCalled();
    expect(mockRefetchStatuses).not.toHaveBeenCalled();
  });

  it("reads the agents and their statuses again each time the tab regains focus", () => {
    render(<AgentsScreen />);

    act(() => mockGainFocus());
    expect(mockRefetchAgents).toHaveBeenCalledTimes(1);
    expect(mockRefetchStatuses).toHaveBeenCalledTimes(1);

    act(() => mockGainFocus());
    expect(mockRefetchAgents).toHaveBeenCalledTimes(2);
    expect(mockRefetchStatuses).toHaveBeenCalledTimes(2);
  });

  it("leaves the first read alone when focus returns while it is still on its way", () => {
    mockUseAgents.mockReturnValue(agentsResult({ agents: [], agentsEnabled: null, isPending: true }));
    render(<AgentsScreen />);

    act(() => mockGainFocus());

    expect(mockRefetchAgents).not.toHaveBeenCalled();
    expect(mockRefetchStatuses).not.toHaveBeenCalled();
  });

  it("reads no statuses on focus while there are no agents to read them for", () => {
    mockUseAgents.mockReturnValue(agentsResult({ agents: [] }));
    render(<AgentsScreen />);

    act(() => mockGainFocus());

    expect(mockRefetchAgents).toHaveBeenCalledTimes(1);
    expect(mockRefetchStatuses).not.toHaveBeenCalled();
  });

  it("reads both again on pull to refresh, and shows the spinner until both have answered", async () => {
    let finish: () => void = () => {};
    render(<AgentsScreen />);
    mockRefetchAgents.mockClear();
    mockRefetchStatuses.mockClear();
    mockRefetchStatuses.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));

    fireEvent(screen.getByTestId("agents-list"), "refresh");
    await waitFor(() => expect(screen.getByTestId("agents-list").props.refreshing).toBe(true));
    expect(mockRefetchAgents).toHaveBeenCalledTimes(1);
    expect(mockRefetchStatuses).toHaveBeenCalledTimes(1);

    await act(async () => finish());
    expect(screen.getByTestId("agents-list").props.refreshing).toBe(false);
  });

  it("shows skeleton rows while the agents load", () => {
    mockUseAgents.mockReturnValue(agentsResult({ agents: [], agentsEnabled: null, isPending: true }));
    render(<AgentsScreen />);

    expect(screen.getAllByTestId("agents-skeleton-row").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("agents-list")).toBeNull();
  });

  it("shows the empty state when there are no agents", () => {
    mockUseAgents.mockReturnValue(agentsResult({ agents: [] }));
    render(<AgentsScreen />);

    expect(screen.getByTestId("agents-empty")).toBeTruthy();
    fireEvent.press(within(screen.getByTestId("agents-empty")).getByRole("button", { name: "New agent" }));
    expect(mockPush).toHaveBeenCalledWith("/agents/new");
  });

  it.each([
    ["the list could not be read", { agents: [], agentsEnabled: null, isError: true }],
    ["agents are switched off on this computer", { agents: [], agentsEnabled: false }],
  ])("shows a generic line with a retry when %s", (_case, overrides) => {
    mockUseAgents.mockReturnValue(agentsResult(overrides));
    render(<AgentsScreen />);
    mockRefetchAgents.mockClear();

    expect(screen.getByRole("alert").props.children).toBe("Agents are not available right now.");
    expect(screen.queryByTestId("agents-list")).toBeNull();

    fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    expect(mockRefetchAgents).toHaveBeenCalledTimes(1);
  });

  it("keeps showing the agents it has when reading them again fails", () => {
    mockUseAgents.mockReturnValue(agentsResult({ isError: true }));
    render(<AgentsScreen />);

    expect(screen.getByTestId("agent-row-bot_research")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
