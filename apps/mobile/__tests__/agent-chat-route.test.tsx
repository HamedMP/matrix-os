import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import { Linking } from "react-native";

import * as mockRoute from "./agent-chat-route-test-utils";
import AgentChatRoute from "../app/(drawer)/(tabs)/agents/[agentId]";
import { openConsentPage } from "../components/agents/use-agent-thread";
import { ModelTrigger } from "../components/chat/ModelTrigger";

jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));
jest.mock("@expo/ui", () => mockRoute.sheetModule());
jest.mock("expo-router", () => mockRoute.expoRouterModule());
jest.mock("@clerk/clerk-expo", () => ({ useAuth: () => ({ isSignedIn: true, userId: "user_a" }) }));
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 62, right: 0, bottom: 34, left: 0 }),
}));
jest.mock("@/lib/use-keyboard-visible", () => ({ useKeyboardVisible: () => false }));
jest.mock("@/lib/use-session-token-warmup", () => ({ useSessionTokenWarmup: () => jest.fn() }));
jest.mock("@/lib/canonical-chat-session-context", () => mockRoute.sessionModule());
jest.mock("@/components/agents/use-agent-chat-sync", () => ({
  useAgentChatSync: (chatId: string | null) => mockRoute.shell.sync(chatId),
}));
jest.mock("@/lib/queries/use-active-gateway", () => ({
  useActiveGateway: () => ({ ready: true, isComputerError: false }),
}));
jest.mock("@/lib/queries/use-agents", () => mockRoute.agentsModule());
jest.mock("@/lib/queries/use-agent-statuses", () => mockRoute.agentStatusesModule());
jest.mock("@/lib/queries/use-canonical-chat-detail", () => mockRoute.chatDetailModule());
jest.mock("@/lib/queries/use-bot-chat", () => mockRoute.botChatModule());
jest.mock("@/lib/queries/use-chat-provider-catalog", () => ({
  useChatProviderCatalog: () => ({ catalog: mockRoute.catalog, isPending: false, isFetching: false }),
}));
jest.mock("@/lib/queries/use-send-chat-message", () => ({
  useSendChatMessage: () => ({ mutate: mockRoute.shell.sendMessage, isPending: false }),
}));
jest.mock("@/lib/queries/use-cancel-run", () => ({
  useCancelRun: () => ({ mutate: mockRoute.shell.cancelRun, isPending: false }),
}));
jest.mock("@/lib/queries/use-computer-apps", () => ({
  useComputerApps: () => ({ apps: [] }),
  installedAppSlug: (app: { slug: string }) => app.slug,
}));

const { router, shell, bot, state, managed, approval, snapshot, chatDetail, runningRun, customStatuses } = mockRoute;

describe("agent chat route", () => {
  beforeEach(mockRoute.reset);
  afterEach(cleanup);

  describe("opening the chat", () => {
    it("reads the agent's own chat by the id its status already carries", () => {
      render(<AgentChatRoute />);

      expect(state.detailChatIds.every((chatId) => chatId === "chat_research")).toBe(true);
      expect(state.botChatIds.every((chatId) => chatId === "chat_research")).toBe(true);
      expect(shell.sync).toHaveBeenLastCalledWith("chat_research");
      expect(shell.ensure).not.toHaveBeenCalled();
      expect(screen.getByRole("header", { name: "Account research" })).toBeTruthy();
      expect(screen.getByText("Brief ready for your call.")).toBeTruthy();
    });

    it("never changes the chat the Chats tab has open", () => {
      render(<AgentChatRoute />);
      fireEvent.changeText(screen.getByLabelText("Message Matrix"), "Who is next?");
      fireEvent.press(screen.getByRole("button", { name: "Send message" }));
      fireEvent.press(screen.getByRole("button", { name: "Agent details" }));
      fireEvent.press(screen.getByRole("button", { name: "Back" }));

      expect(shell.selectChat).not.toHaveBeenCalled();
      expect(shell.startDraftChat).not.toHaveBeenCalled();
      expect(shell.bindDraftChatId).not.toHaveBeenCalled();
    });

    it("asks the server for the chat when the statuses name none, with skeleton rows until it answers", () => {
      state.statuses = {};
      const view = render(<AgentChatRoute />);

      expect(shell.ensure).toHaveBeenCalledTimes(1);
      expect(shell.ensure).toHaveBeenCalledWith("bot_research1");
      expect(screen.getAllByTestId("agent-chat-skeleton-row").length).toBeGreaterThan(0);
      expect(screen.queryByTestId("composer")).toBeNull();
      expect(state.detailChatIds.every((chatId) => chatId === null)).toBe(true);

      state.ensure = { data: "chat_created", variables: "bot_research1", isError: false };
      view.rerender(<AgentChatRoute />);

      expect(state.detailChatIds[state.detailChatIds.length - 1]).toBe("chat_created");
      expect(screen.getByTestId("composer")).toBeTruthy();
      expect(shell.ensure).toHaveBeenCalledTimes(1);
    });

    it("says in generic words that the chat could not be opened, and looks again on Try again", () => {
      state.statuses = {};
      state.ensure = { variables: "bot_research1", isError: true };
      render(<AgentChatRoute />);
      shell.ensure.mockClear();

      expect(screen.getByRole("alert").props.children).toBe("This agent's chat could not be opened.");
      expect(screen.queryByTestId("composer")).toBeNull();
      fireEvent.press(screen.getByRole("button", { name: "Try again" }));

      expect(shell.ensure).toHaveBeenCalledTimes(1);
      expect(shell.ensure).toHaveBeenCalledWith("bot_research1");
    });

    it("goes back from the top bar", () => {
      render(<AgentChatRoute />);

      fireEvent.press(screen.getByRole("button", { name: "Back" }));

      expect(router.back).toHaveBeenCalledTimes(1);
      expect(router.replace).not.toHaveBeenCalled();
    });

    it("goes to the Agents list from the top bar when there is no screen under this one", () => {
      router.canGoBack.mockReturnValue(false);
      render(<AgentChatRoute />);

      fireEvent.press(screen.getByRole("button", { name: "Back" }));

      expect(router.back).not.toHaveBeenCalled();
      expect(router.replace).toHaveBeenCalledWith("/agents");
    });

    it("calls an agent that is not in the list simply Agent, and sends nothing for it", () => {
      state.agentId = "bot_unknown01";
      state.statuses = { bot_unknown01: { state: "idle", label: "No open tasks", chatId: "chat_unknown", lastActivityAt: null } };
      state.botSnapshot = null;
      render(<AgentChatRoute />);

      expect(screen.getByRole("header", { name: "Agent" })).toBeTruthy();
      // Nothing says what its turns would run on, so nothing can be sent yet.
      fireEvent.changeText(screen.getByLabelText("Message Matrix"), "Hello");
      expect(screen.getByRole("button", { name: "Send message" }).props.accessibilityState).toMatchObject({ disabled: true });
    });
  });

  describe("composer", () => {
    it("invites a message to the agent by name, with no model control", () => {
      render(<AgentChatRoute />);

      expect(screen.getByPlaceholderText("Ask Account research…")).toBeTruthy();
      expect(screen.UNSAFE_queryByType(ModelTrigger)).toBeNull();
      expect(screen.queryByRole("button", { name: "Model" })).toBeNull();
    });

    it("sends to the agent's chat on the computer's agent route, in no project", () => {
      render(<AgentChatRoute />);
      fireEvent.changeText(screen.getByLabelText("Message Matrix"), "Who is next?");

      fireEvent.press(screen.getByRole("button", { name: "Send message" }));

      expect(shell.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        chatId: "chat_research", baseRevision: 4, text: "Who is next?", projectId: null,
        selection: { instanceId: "matrix_bot_default", model: "auto" },
        interactionMode: "default", permissionMode: "default",
      }), expect.anything());
    });

    it("turns send into stop while a turn runs, and stop cancels that run", () => {
      state.detail = chatDetail({ runs: [runningRun] });
      render(<AgentChatRoute />);

      expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
      fireEvent.press(screen.getByRole("button", { name: "Stop" }));

      expect(shell.cancelRun).toHaveBeenCalledWith({ chatId: "chat_research", runId: "run_live" });
    });

    it("sends an agent of the person's own with what its chat was last sent with, and reads no status for it", () => {
      state.agentId = "bot_custom001";
      state.statuses = customStatuses;
      state.detail = chatDetail({
        record: { projectId: null, chat: { id: "chat_custom", title: "Release notes", revision: 2, currentSelection: managed } },
      });
      state.botError = true;
      render(<AgentChatRoute />);
      fireEvent.changeText(screen.getByLabelText("Message Matrix"), "Draft them");

      fireEvent.press(screen.getByRole("button", { name: "Send message" }));

      expect(shell.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        chatId: "chat_custom", selection: managed, interactionMode: "default", permissionMode: "supervised",
      }), expect.anything());
      expect(state.botChatIds.every((chatId) => chatId === null)).toBe(true);
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });

  describe("what the agent is waiting for", () => {
    it("draws a pending approval after the messages, and Allow once answers it in this chat", async () => {
      state.botSnapshot = snapshot({ interactions: [approval] });
      render(<AgentChatRoute />);

      const card = screen.getByTestId("interaction-in_abcdefgh");
      expect(within(card).getByRole("header", { name: "Slack · #northwind-deal" })).toBeTruthy();
      expect(within(screen.getByTestId("pending-interactions")).getByText("Needs your approval")).toBeTruthy();
      fireEvent.press(screen.getByRole("button", { name: "Allow once" }));

      await waitFor(() => expect(bot.resolve).toHaveBeenCalledWith("in_abcdefgh", {
        kind: "approval", baseRevision: 3, decision: "approve",
      }));
      await waitFor(() => expect(bot.refresh).toHaveBeenCalledTimes(1));
      expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
    });

    it("draws nothing extra while the agent waits for nothing", () => {
      render(<AgentChatRoute />);

      expect(screen.queryByTestId("pending-interactions")).toBeNull();
    });

    it("says so, and holds the answers back, while the agent's status cannot be read again", () => {
      state.botSnapshot = snapshot({ interactions: [approval] });
      state.botError = true;
      render(<AgentChatRoute />);

      expect(screen.getByText("Agent status could not be loaded. Try again.")).toBeTruthy();
      expect(screen.getByText("Status unavailable. Refresh to respond.")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
    });

    it("opens a consent page only over https", async () => {
      const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true);

      await openConsentPage("https://example.com/consent");
      expect(openURL).toHaveBeenCalledWith("https://example.com/consent");
      openURL.mockClear();

      await expect(openConsentPage("http://example.com/consent")).rejects.toThrow();
      await expect(openConsentPage("matrixos://consent")).rejects.toThrow();
      expect(openURL).not.toHaveBeenCalled();
      openURL.mockRestore();
    });
  });
});
