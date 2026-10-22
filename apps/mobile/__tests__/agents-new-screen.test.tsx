import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react-native";

import NewAgentRoute from "../app/(drawer)/(tabs)/agents/new";
import { inspirationSetupPrompt } from "../components/agents/agent-gallery";
import { agentInspirations } from "../components/agents/agent-inspirations.generated";
import { consumeChatDraftRequest, useChatDraftRequest } from "../components/agents/chat-draft-request";
import { templateSetupPrompt } from "../components/agents/agent-templates";
import { mobileQueryKeys } from "../lib/requests/query-keys";
import { HOSTED_GATEWAY_URL } from "../lib/storage";

const mockSelectChat = jest.fn();
const mockStartDraftChat = jest.fn();
const mockInvalidateChats = jest.fn(() => Promise.resolve());
const mockShowChatScreen = jest.fn();
const mockGoBack = jest.fn();
// Asks the Agents tab's layout for the chat screen once this screen has closed,
// and returns the way to take the request back.
const mockStopWaitingForChat = jest.fn();
const mockShowChatAfterClosing = jest.fn(() => mockStopWaitingForChat);
let mockInsideAgentsTab = true;
// The options the screen last gave its own entry in the stack.
let mockScreenOptions: { animation?: string } | undefined;
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
type SheetState = { isPresented: boolean; onDismiss: () => void };
// The setup sheet of a template, and the sheet of an inspiration.
let mockSheet: SheetState = { isPresented: false, onDismiss: () => {} };
let mockInspirationSheet: SheetState = { isPresented: false, onDismiss: () => {} };

jest.mock("@expo/ui", () => {
  const { View } = jest.requireActual("react-native") as typeof import("react-native");
  return {
    BottomSheet: (props: SheetState & { children: ReactNode; testID?: string }) => {
      if (props.testID === "inspiration-sheet") mockInspirationSheet = props;
      else mockSheet = props;
      return <View testID={props.testID}>{props.children}</View>;
    },
    RNHostView: ({ children }: { children: ReactNode }) => children,
  };
});
jest.mock("expo-router", () => ({
  Stack: {
    Screen: (props: { options?: { animation?: string } }) => {
      mockScreenOptions = props.options;
      return null;
    },
  },
  useNavigation: () => ({
    goBack: mockGoBack,
    isFocused: () => mockFocused,
    getState: () => ({ routes: mockStackRoutes }),
  }),
  useRouter: () => ({ replace: mockReplace, push: mockPush }),
}));
jest.mock("@/components/agents/chat-handoff", () => ({
  useShowChatAfterClosing: () => (mockInsideAgentsTab ? mockShowChatAfterClosing : null),
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

/** The gallery's rows, in the order they are listed. */
function listedRows(): string[] {
  return screen
    .getAllByTestId(/^template-row-/)
    .filter((node) => node.props.accessibilityRole === "button")
    .map((node) => String(node.props.testID).replace("template-row-", ""));
}

// "Ad Spend Watch", the first inspiration no computer has a template for.
const adSpendWatch = agentInspirations.find((inspiration) => inspiration.id === "fuse")!;

describe("new agent route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFocused = true;
    mockInsideAgentsTab = true;
    // Going back closes this screen: the stack is left with what was behind it.
    mockGoBack.mockImplementation(() => {
      mockStackRoutes = mockStackRoutes.slice(0, -1);
    });
    mockShowChatAfterClosing.mockImplementation(() => mockStopWaitingForChat);
    mockScreenOptions = undefined;
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
    expect(screen.getByRole("alert").props.children).toBe("Some templates could not be loaded.");
    // The gallery the app ships with needs no computer to be listed.
    expect(listedRows()[0]).toBe("fuse");

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

  it("lists the gallery's inspirations after the computer's templates", () => {
    render(<NewAgentRoute />);

    expect(listedRows().slice(0, 5)).toEqual([
      "inbox-triage",
      "account-research",
      "fuse",
      "ai-search-visibility",
      "alfred",
    ]);
    expect(screen.getByText("Ad Spend Watch")).toBeTruthy();
  });

  it("lists a template the computer has once, not again as the inspiration of the same id", () => {
    expect(agentInspirations.map((inspiration) => inspiration.id)).toContain("account-research");
    render(<NewAgentRoute />);

    fireEvent.changeText(screen.getByLabelText("Search templates"), "account research");

    expect(listedRows()).toEqual(["account-research"]);
    // The computer's own, not the gallery's "GTM Account Research".
    expect(screen.getByText("Account research")).toBeTruthy();
    expect(screen.queryByText("GTM Account Research")).toBeNull();
  });

  it("finds an inspiration by a skill or an app it works with", () => {
    render(<NewAgentRoute />);

    fireEvent.changeText(screen.getByLabelText("Search templates"), "datadog");
    expect(listedRows()).toEqual(["fuse"]);

    fireEvent.changeText(screen.getByLabelText("Search templates"), "check budget pace");
    expect(listedRows()).toEqual(["fuse"]);
  });

  it("starts on every category and narrows the gallery to the one whose chip is pressed", () => {
    render(<NewAgentRoute />);
    expect(screen.getByTestId("template-category-All").props.accessibilityState).toMatchObject({ selected: true });

    fireEvent.press(screen.getByTestId("template-category-Engineering"));

    expect(screen.getByTestId("template-category-Engineering").props.accessibilityState).toMatchObject({ selected: true });
    expect(screen.getByTestId("template-category-All").props.accessibilityState).toMatchObject({ selected: false });
    expect(listedRows()).toEqual([
      "engineer-bot", "nightly-audit-engineer", "projects-manager", "researchy", "tinkabot",
    ]);

    fireEvent.press(screen.getByTestId("template-category-All"));
    expect(listedRows().slice(0, 3)).toEqual(["inbox-triage", "account-research", "fuse"]);
  });

  it("files a template of the computer under the category of the inspiration it shares an id with", () => {
    render(<NewAgentRoute />);

    fireEvent.press(screen.getByTestId("template-category-Sales"));

    expect(listedRows()[0]).toBe("account-research");
    expect(listedRows()).not.toContain("inbox-triage");
    expect(listedRows()).toContain("call-follow-ups");
  });

  it("searches inside the chosen category, and keeps the category while the search changes", () => {
    render(<NewAgentRoute />);
    fireEvent.press(screen.getByTestId("template-category-Engineering"));

    fireEvent.changeText(screen.getByLabelText("Search templates"), "audit");
    expect(listedRows()).toEqual(["nightly-audit-engineer"]);

    fireEvent.changeText(screen.getByLabelText("Search templates"), "ad spend");
    expect(screen.queryByTestId(/^template-row-/)).toBeNull();
    expect(screen.getByText("No templates match that search.")).toBeTruthy();

    fireEvent.press(screen.getByTestId("template-category-Marketing"));
    expect(listedRows()).toEqual(["fuse"]);
  });

  it("opens an inspiration in its own sheet, with nothing to create", () => {
    render(<NewAgentRoute />);
    expect(mockInspirationSheet.isPresented).toBe(false);

    fireEvent.press(screen.getByTestId("template-row-fuse"));

    expect(mockInspirationSheet.isPresented).toBe(true);
    expect(mockSheet.isPresented).toBe(false);
    const sheet = screen.getByTestId("inspiration-sheet");
    expect(within(sheet).getByRole("header", { name: "Ad Spend Watch" })).toBeTruthy();
    expect(within(sheet).getByText("Marketing")).toBeTruthy();
    expect(within(sheet).getByText(adSpendWatch.description)).toBeTruthy();
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create agent" })).toBeNull();
  });

  it("builds an inspiration in an ordinary chat: a new chat whose composer is asked to hold the web's prompt", () => {
    render(<NewAgentRoute />);
    fireEvent.press(screen.getByTestId("template-row-fuse"));

    fireEvent.press(screen.getByRole("button", { name: "Build in chat" }));

    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockInspirationSheet.isPresented).toBe(false);
    expect(mockStartDraftChat).toHaveBeenCalledTimes(1);
    expect(mockSelectChat).not.toHaveBeenCalled();
    expect(pendingDraft()?.text).toBe(inspirationSetupPrompt(adSpendWatch));
    expect(pendingDraft()?.text).toContain("Suggested capabilities: Answer a spend question, Check budget pace");
    expect(mockShowChatAfterClosing).toHaveBeenCalledTimes(1);
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("closes itself and leaves showing the chat to the tab's layout, which waits until the tabs have taken the closing in", () => {
    render(<NewAgentRoute />);
    fireEvent.press(screen.getByTestId("template-row-fuse"));

    fireEvent.press(screen.getByRole("button", { name: "Build in chat" }));

    // The Agents tab is left on its list. A switch asked for in the same step
    // as the closing is dropped by the navigator, so this screen does not ask.
    expect(mockShowChatAfterClosing).toHaveBeenCalledTimes(1);
    expect(mockGoBack).toHaveBeenCalledTimes(1);
    expect(mockShowChatAfterClosing.mock.invocationCallOrder[0]).toBeLessThan(mockGoBack.mock.invocationCallOrder[0]);
    expect(mockStartDraftChat.mock.invocationCallOrder[0]).toBeLessThan(mockGoBack.mock.invocationCallOrder[0]);
    expect(mockShowChatScreen).not.toHaveBeenCalled();
    expect(mockStopWaitingForChat).not.toHaveBeenCalled();
  });

  it("takes the request back and shows the chat itself when going back closed nothing", () => {
    mockGoBack.mockImplementation(() => {});
    render(<NewAgentRoute />);
    fireEvent.press(screen.getByTestId("template-row-fuse"));

    fireEvent.press(screen.getByRole("button", { name: "Build in chat" }));

    // No change is coming for the layout to wait for; left waiting, it would
    // show the chat on the next unrelated change of the tabs.
    expect(mockStopWaitingForChat).toHaveBeenCalledTimes(1);
    expect(mockShowChatScreen).toHaveBeenCalledTimes(1);
    expect(mockStopWaitingForChat.mock.invocationCallOrder[0]).toBeLessThan(mockShowChatScreen.mock.invocationCallOrder[0]);
  });

  it("asks for nothing when a sheet is only closed", () => {
    render(<NewAgentRoute />);
    fireEvent.press(screen.getByTestId("template-row-fuse"));
    fireEvent.press(screen.getByRole("button", { name: "Close" }));

    expect(mockShowChatAfterClosing).not.toHaveBeenCalled();
    expect(mockShowChatScreen).not.toHaveBeenCalled();
    expect(mockGoBack).not.toHaveBeenCalled();
  });

  it("leaves without a slide while one of its sheets is open, and with the usual one otherwise", () => {
    render(<NewAgentRoute />);
    expect(mockScreenOptions).toEqual({ animation: "default" });

    // A sheet's button can leave for the Chats tab, which hides this screen at once.
    fireEvent.press(screen.getByTestId("template-row-fuse"));
    expect(mockScreenOptions).toEqual({ animation: "none" });
    fireEvent.press(screen.getByRole("button", { name: "Close" }));
    expect(mockScreenOptions).toEqual({ animation: "default" });

    openSetup();
    expect(mockScreenOptions).toEqual({ animation: "none" });
    act(() => mockSheet.onDismiss());
    expect(mockScreenOptions).toEqual({ animation: "default" });
  });

  it("closes an inspiration's sheet from its close button and when it is dragged away, starting no chat", () => {
    render(<NewAgentRoute />);
    fireEvent.press(screen.getByTestId("template-row-fuse"));
    fireEvent.press(screen.getByRole("button", { name: "Close" }));
    expect(mockInspirationSheet.isPresented).toBe(false);

    fireEvent.press(screen.getByTestId("template-row-fuse"));
    act(() => mockInspirationSheet.onDismiss());
    expect(mockInspirationSheet.isPresented).toBe(false);
    expect(mockStartDraftChat).not.toHaveBeenCalled();
    expect(mockShowChatScreen).not.toHaveBeenCalled();
    expect(pendingDraft()).toBeNull();
  });

  it("still builds an inspiration in chat when the computer's templates could not be read", () => {
    mockUseBotRecipes.mockReturnValue(recipesResult({ recipes: [], isError: true }));
    render(<NewAgentRoute />);

    fireEvent.press(screen.getByTestId("template-row-fuse"));
    fireEvent.press(screen.getByRole("button", { name: "Build in chat" }));

    expect(pendingDraft()?.text).toBe(inspirationSetupPrompt(adSpendWatch));
    expect(mockShowChatAfterClosing).toHaveBeenCalledTimes(1);
    expect(mockGoBack).toHaveBeenCalledTimes(1);
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
    // This screen closes, and the tab's layout shows the chat once the tabs have taken that in.
    expect(mockShowChatAfterClosing).toHaveBeenCalledTimes(1);
    expect(mockGoBack).toHaveBeenCalledTimes(1);
    expect(mockStartDraftChat.mock.invocationCallOrder[0]).toBeLessThan(mockGoBack.mock.invocationCallOrder[0]);
    expect(mockShowChatScreen).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it.each([
    ["there is nothing behind this screen", () => { mockStackRoutes = [{ name: "new" }]; }],
    ["this screen is no longer the one in front", () => { mockFocused = false; }],
  ])("shows the chat at once, without going back, when %s", (_case, arrange) => {
    render(<NewAgentRoute />);
    openSetup();
    arrange();

    fireEvent.press(screen.getByRole("button", { name: "Set up in chat instead" }));

    expect(mockStartDraftChat).toHaveBeenCalledTimes(1);
    expect(mockShowChatScreen).toHaveBeenCalledTimes(1);
    expect(mockStartDraftChat.mock.invocationCallOrder[0]).toBeLessThan(mockShowChatScreen.mock.invocationCallOrder[0]);
    expect(mockGoBack).not.toHaveBeenCalled();
    // Nothing is left waiting for a change that will not come.
    expect(mockShowChatAfterClosing).not.toHaveBeenCalled();
  });

  it("shows the chat at once when it is drawn outside the Agents tab, where nothing would wait for it", () => {
    mockInsideAgentsTab = false;
    render(<NewAgentRoute />);
    openSetup();

    fireEvent.press(screen.getByRole("button", { name: "Set up in chat instead" }));

    expect(mockShowChatScreen).toHaveBeenCalledTimes(1);
    expect(mockGoBack).not.toHaveBeenCalled();
  });

  it("draws none of the controls the server has nothing behind", () => {
    render(<NewAgentRoute />);
    openSetup();

    for (const text of [
      "Start from scratch",
      "Apps", "Runs", "Connect", "Connected", "When I ask", "Before each meeting", "Every morning",
      "A one-page brief",
    ]) {
      expect(screen.queryByText(text)).toBeNull();
    }
    expect(screen.queryByRole("radio")).toBeNull();
  });
});
