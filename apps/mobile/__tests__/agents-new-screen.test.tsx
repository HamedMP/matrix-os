import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react-native";

import NewAgentRoute from "../app/(drawer)/(tabs)/agents/new";
import { consumeChatDraftRequest, useChatDraftRequest } from "../components/agents/chat-draft-request";
import { templateSetupPrompt } from "../components/agents/agent-templates";
import { mobileQueryKeys } from "../lib/requests/query-keys";
import { HOSTED_GATEWAY_URL } from "../lib/storage";

const mockSelectChat = jest.fn();
const mockStartDraftChat = jest.fn();
const mockInvalidateChats = jest.fn(() => Promise.resolve());
const mockShowChatScreen = jest.fn();
const mockGoBack = jest.fn();
const mockReplace = jest.fn();
const mockPush = jest.fn();
const mockRefetchAgents = jest.fn(() => Promise.resolve());
const mockCreate = jest.fn();
const mockRefetchRecipes = jest.fn(() => Promise.resolve());
const mockInvalidateQueries = jest.fn(() => Promise.resolve());
const mockUseBotRecipes = jest.fn();
let mockFocused = true;
let mockStackRoutes: { name: string }[] = [];
let mockComputer: { gatewayPath: string } | undefined;
let mockChatsError = false;
let mockSheet: { isPresented: boolean; onDismiss: () => void } = { isPresented: false, onDismiss: () => {} };

jest.mock("@expo/ui", () => {
  const { View } = jest.requireActual("react-native") as typeof import("react-native");
  return {
    BottomSheet: (props: { children: ReactNode; isPresented: boolean; onDismiss: () => void }) => {
      mockSheet = props;
      return <View testID="expo-bottom-sheet">{props.children}</View>;
    },
    RNHostView: ({ children }: { children: ReactNode }) => children,
  };
});
jest.mock("expo-router", () => ({
  useNavigation: () => ({
    goBack: mockGoBack,
    isFocused: () => mockFocused,
    getState: () => ({ routes: mockStackRoutes }),
  }),
  useRouter: () => ({ replace: mockReplace, push: mockPush }),
}));
jest.mock("@/lib/queries/use-agents", () => ({ useAgents: () => ({ refetch: mockRefetchAgents }) }));
jest.mock("@clerk/clerk-expo", () => ({ useAuth: () => ({ userId: "user_a" }) }));
jest.mock("@tanstack/react-query", () => ({
  ...jest.requireActual("@tanstack/react-query"),
  useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
}));
jest.mock("@/lib/canonical-chat-session-context", () => ({
  useCanonicalChatSession: () => ({ selectChat: mockSelectChat, startDraftChat: mockStartDraftChat }),
}));
jest.mock("@/lib/queries/use-canonical-chats", () => ({
  useCanonicalChats: () => ({ computer: mockComputer, isError: mockChatsError, invalidate: mockInvalidateChats }),
}));
jest.mock("@/lib/queries/use-bot-recipes", () => ({
  useBotRecipes: (...args: unknown[]) => mockUseBotRecipes(...args),
}));
jest.mock("@/lib/use-shell-navigation", () => ({ useShowChatScreen: () => mockShowChatScreen }));

const inbox = {
  recipeId: "inbox-triage",
  version: "v1",
  name: "Inbox triage",
  description: "Sorts your inbox and drafts replies",
  output: "A triaged mailbox",
};
const research = {
  recipeId: "account-research",
  version: "v2",
  name: "Account research",
  description: "Briefs you before every sales call",
  output: "A one-page brief",
};
const gatewayUrl = `${HOSTED_GATEWAY_URL}/vm/solar-vale`;
const created = { agentId: "bot_keyaccounts", chatId: "chat_new_agent" };
const createdRoute = { pathname: "/agents/[agentId]", params: { agentId: "bot_keyaccounts" } };

function recipesResult(overrides: Record<string, unknown> = {}) {
  return {
    recipes: [inbox, research],
    isPending: false,
    isError: false,
    create: mockCreate,
    refetch: mockRefetchRecipes,
    ...overrides,
  };
}

function pendingDraft() {
  const { result, unmount } = renderHook(() => useChatDraftRequest());
  const request = result.current;
  unmount();
  return request;
}

function openSetup(recipeId = "account-research") {
  fireEvent.press(screen.getByTestId(`template-row-${recipeId}`));
}

describe("new agent route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFocused = true;
    mockStackRoutes = [{ name: "index" }, { name: "new" }];
    mockChatsError = false;
    mockComputer = { gatewayPath: "/vm/solar-vale" };
    mockUseBotRecipes.mockReturnValue(recipesResult());
  });

  afterEach(() => {
    cleanup();
    const request = pendingDraft();
    if (request) consumeChatDraftRequest(request.id);
  });

  it("reads the templates of the signed-in computer", () => {
    render(<NewAgentRoute />);

    expect(mockUseBotRecipes).toHaveBeenCalledWith(gatewayUrl, true);
    expect(screen.getByTestId("template-row-inbox-triage")).toBeTruthy();
    expect(screen.getByTestId("template-row-account-research")).toBeTruthy();
  });

  it("goes back from the top bar", () => {
    render(<NewAgentRoute />);

    fireEvent.press(screen.getByRole("button", { name: "Back" }));

    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it("shows skeleton rows while the templates load, and while no computer is known yet", () => {
    mockUseBotRecipes.mockReturnValue(recipesResult({ recipes: [], isPending: true }));
    render(<NewAgentRoute />);
    expect(screen.getAllByTestId("template-skeleton-row").length).toBeGreaterThan(0);
    cleanup();

    mockComputer = undefined;
    render(<NewAgentRoute />);
    expect(mockUseBotRecipes).toHaveBeenLastCalledWith(null, true);
    expect(screen.getAllByTestId("template-skeleton-row").length).toBeGreaterThan(0);
  });

  it.each([
    ["the templates could not be read", "templates", () => {
      mockUseBotRecipes.mockReturnValue(recipesResult({ recipes: [], isError: true }));
    }],
    ["the computer could not be found", "computer", () => {
      mockComputer = undefined;
      mockChatsError = true;
      mockUseBotRecipes.mockReturnValue(recipesResult({ recipes: [], isPending: true }));
    }],
  ] as const)("says in generic words that %s, and Try again reads the %s again", (_case, read, arrange) => {
    arrange();
    render(<NewAgentRoute />);
    expect(screen.getByRole("alert").props.children).toBe("Templates could not be loaded.");
    expect(screen.queryByTestId("template-list")).toBeNull();

    fireEvent.press(screen.getByRole("button", { name: "Try again" }));

    // Without a computer the templates cannot be read; they follow once it is found.
    expect(mockRefetchRecipes).toHaveBeenCalledTimes(read === "templates" ? 1 : 0);
    expect(mockInvalidateQueries.mock.calls).toEqual(
      read === "computer" ? [[{ queryKey: mobileQueryKeys.activeComputer("user_a") }]] : [],
    );
  });

  it("filters the templates by name and description as the search is typed", () => {
    render(<NewAgentRoute />);

    fireEvent.changeText(screen.getByLabelText("Search templates"), "SALES call");
    expect(screen.queryByTestId("template-row-inbox-triage")).toBeNull();
    expect(screen.getByTestId("template-row-account-research")).toBeTruthy();

    fireEvent.changeText(screen.getByLabelText("Search templates"), "inbox");
    expect(screen.getByTestId("template-row-inbox-triage")).toBeTruthy();
    expect(screen.queryByTestId("template-row-account-research")).toBeNull();

    fireEvent.changeText(screen.getByLabelText("Search templates"), "mailbox");
    expect(screen.queryByTestId(/^template-row-/)).toBeNull();
    expect(screen.getByText("No templates match that search.")).toBeTruthy();
  });

  it("opens the setup sheet for the pressed template, with its name filled in", () => {
    render(<NewAgentRoute />);
    expect(mockSheet.isPresented).toBe(false);

    openSetup();

    expect(mockSheet.isPresented).toBe(true);
    expect(screen.getByLabelText("Name").props.value).toBe("Account research");
  });

  it("creates the agent from the template under the typed name, with the automatic model", async () => {
    let finishCreate: (agent: typeof created) => void = () => {};
    mockCreate.mockReturnValue(new Promise<typeof created>((resolve) => { finishCreate = resolve; }));
    render(<NewAgentRoute />);
    openSetup();
    fireEvent.changeText(screen.getByLabelText("Name"), " Key accounts ");

    fireEvent.press(screen.getByRole("button", { name: "Create agent" }));

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const [recipe, requestId, selection, name] = mockCreate.mock.calls[0];
    expect(recipe).toEqual({ recipeId: "account-research", version: "v2" });
    expect(requestId).toMatch(/^req_[a-z0-9]+$/);
    expect(selection).toBeUndefined();
    expect(name).toBe("Key accounts");
    // Nothing moves until the server answers.
    await waitFor(() => (
      expect(screen.getByRole("button", { name: "Create agent" }).props.accessibilityState).toMatchObject({ busy: true })
    ));
    expect(mockSheet.isPresented).toBe(true);
    expect(mockReplace).not.toHaveBeenCalled();

    await act(async () => finishCreate(created));
    expect(mockSheet.isPresented).toBe(false);
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith(createdRoute);
    // The chat list has one chat more, and the agents list one agent more.
    expect(mockInvalidateChats).toHaveBeenCalledTimes(1);
    expect(mockRefetchAgents).toHaveBeenCalledTimes(1);
  });

  it("opens the new agent's own chat, leaving the Chats tab and its open chat alone", async () => {
    mockCreate.mockResolvedValue(created);
    render(<NewAgentRoute />);
    openSetup();

    fireEvent.press(screen.getByRole("button", { name: "Create agent" }));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith(createdRoute));
    expect(mockSelectChat).not.toHaveBeenCalled();
    expect(mockStartDraftChat).not.toHaveBeenCalled();
    expect(mockShowChatScreen).not.toHaveBeenCalled();
  });

  it("puts the agent's chat in this screen's place, so going back from it shows the Agents list", async () => {
    mockCreate.mockResolvedValue(created);
    render(<NewAgentRoute />);
    openSetup();

    fireEvent.press(screen.getByRole("button", { name: "Create agent" }));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledTimes(1));
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockGoBack).not.toHaveBeenCalled();
  });

  it("opens the agent's chat on top of wherever the person is, when this screen was left while the agent was being created", async () => {
    let finishCreate: (agent: typeof created) => void = () => {};
    mockCreate.mockReturnValue(new Promise<typeof created>((resolve) => { finishCreate = resolve; }));
    render(<NewAgentRoute />);
    openSetup();
    fireEvent.press(screen.getByRole("button", { name: "Create agent" }));

    mockFocused = false;
    await act(async () => finishCreate(created));

    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith(createdRoute);
    // There is nothing of this screen left to replace.
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockGoBack).not.toHaveBeenCalled();
  });

  it("keeps the sheet and the name, and says so in generic words, when the agent could not be created", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    mockCreate.mockRejectedValue(new Error("upstream said no"));
    render(<NewAgentRoute />);
    openSetup();
    fireEvent.changeText(screen.getByLabelText("Name"), "Key accounts");

    fireEvent.press(screen.getByRole("button", { name: "Create agent" }));

    expect(await screen.findByText("Agent could not be created. Try again.")).toBeTruthy();
    expect(screen.queryByText(/upstream said no/)).toBeNull();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("upstream said no");
    expect(mockSheet.isPresented).toBe(true);
    expect(screen.getByLabelText("Name").props.value).toBe("Key accounts");
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockShowChatScreen).not.toHaveBeenCalled();
    expect(mockGoBack).not.toHaveBeenCalled();
    expect(mockRefetchAgents).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("retries under the same request id, also after the sheet was closed and opened again, so the server cannot make the agent twice", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    mockCreate.mockRejectedValue(new Error("response lost"));
    render(<NewAgentRoute />);
    openSetup();
    fireEvent.press(screen.getByRole("button", { name: "Create agent" }));
    await screen.findByText("Agent could not be created. Try again.");

    fireEvent.press(screen.getByRole("button", { name: "Close" }));
    expect(mockSheet.isPresented).toBe(false);
    openSetup();
    expect(screen.queryByText("Agent could not be created. Try again.")).toBeNull();
    fireEvent.press(screen.getByRole("button", { name: "Create agent" }));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(2));
    expect(mockCreate.mock.calls[1][1]).toBe(mockCreate.mock.calls[0][1]);
    await screen.findByText("Agent could not be created. Try again.");
    warn.mockRestore();
  });

  it("closes the sheet from its close button and when it is dragged away, creating nothing", () => {
    render(<NewAgentRoute />);
    openSetup();
    fireEvent.press(screen.getByRole("button", { name: "Close" }));
    expect(mockSheet.isPresented).toBe(false);

    openSetup();
    act(() => mockSheet.onDismiss());
    expect(mockSheet.isPresented).toBe(false);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("sets the template up in an ordinary chat instead: a new chat whose composer is asked to hold the prepared prompt", () => {
    render(<NewAgentRoute />);
    openSetup();

    fireEvent.press(screen.getByRole("button", { name: "Set up in chat instead" }));

    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSheet.isPresented).toBe(false);
    expect(mockStartDraftChat).toHaveBeenCalledTimes(1);
    expect(mockSelectChat).not.toHaveBeenCalled();
    expect(pendingDraft()?.text).toBe(templateSetupPrompt(research));
    expect(mockGoBack).toHaveBeenCalledTimes(1);
    expect(mockShowChatScreen).toHaveBeenCalledTimes(1);
    expect(mockStartDraftChat.mock.invocationCallOrder[0]).toBeLessThan(mockShowChatScreen.mock.invocationCallOrder[0]);
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it.each([
    ["there is nothing behind this screen", () => { mockStackRoutes = [{ name: "new" }]; }],
    ["this screen is no longer the one in front", () => { mockFocused = false; }],
  ])("sets up in chat without going back when %s", (_case, arrange) => {
    render(<NewAgentRoute />);
    openSetup();
    arrange();

    fireEvent.press(screen.getByRole("button", { name: "Set up in chat instead" }));

    expect(mockStartDraftChat).toHaveBeenCalledTimes(1);
    expect(mockShowChatScreen).toHaveBeenCalledTimes(1);
    expect(mockGoBack).not.toHaveBeenCalled();
  });

  it("draws none of the controls the server has nothing behind", () => {
    render(<NewAgentRoute />);
    openSetup();

    for (const text of [
      "Start from scratch", "All", "Personal", "Sales", "Marketing", "Ops",
      "Apps", "Runs", "Connect", "Connected", "When I ask", "Before each meeting", "Every morning",
      "A one-page brief",
    ]) {
      expect(screen.queryByText(text)).toBeNull();
    }
    expect(screen.queryByRole("radio")).toBeNull();
  });
});
