import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import { Alert } from "react-native";

import * as mockRoute from "./agent-chat-route-test-utils";
import AgentChatRoute from "../app/(drawer)/(tabs)/agents/[agentId]";
import { AgentRequestError } from "../lib/requests/bots";

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

const { router, shell, bot, state, sheet, managed, approval, snapshot, customStatuses } = mockRoute;

type AlertButton = { text?: string; style?: string; onPress?: () => void };

describe("agent chat route: details and archiving", () => {
  let alert: jest.SpyInstance;
  let warn: jest.SpyInstance;

  const alertButton = (text: string) => (
    (alert.mock.calls[alert.mock.calls.length - 1][2] as AlertButton[]).find((button) => button.text === text)!
  );

  function openDetails() {
    render(<AgentChatRoute />);
    fireEvent.press(screen.getByRole("button", { name: "Agent details" }));
  }

  beforeEach(() => {
    mockRoute.reset();
    alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    alert.mockRestore();
    warn.mockRestore();
  });

  describe("details", () => {
    it("opens the sheet from the info button, with the agent's description, apps and what it runs on", () => {
      render(<AgentChatRoute />);
      expect(sheet.isPresented).toBe(false);

      fireEvent.press(screen.getByRole("button", { name: "Agent details" }));

      expect(sheet.isPresented).toBe(true);
      const drawn = screen.getByTestId("expo-bottom-sheet");
      expect(within(drawn).getByRole("header", { name: "Account research" })).toBeTruthy();
      expect(within(drawn).getByText("Briefs you before every sales call")).toBeTruthy();
      expect(within(drawn).getByText("Google Drive")).toBeTruthy();
      expect(within(drawn).getByText("Connected")).toBeTruthy();
      expect(within(drawn).getByText("Runs on Automatic")).toBeTruthy();
    });

    it("closes the sheet when it is dragged away", () => {
      openDetails();

      act(() => sheet.onDismiss());

      expect(sheet.isPresented).toBe(false);
    });

    it("names the saved model of an agent that has one", () => {
      state.botSnapshot = snapshot({ selection: managed });
      openDetails();

      expect(screen.getByText("Runs on Pi · Claude Sonnet 5 via Matrix AI")).toBeTruthy();
    });

    it("changes the model, then reads the agent's status and the agents list again", async () => {
      openDetails();

      fireEvent.press(screen.getByRole("button", { name: "Claude Sonnet 5 · Matrix AI" }));

      await waitFor(() => expect(bot.updateModel).toHaveBeenCalledWith(managed));
      await waitFor(() => expect(bot.refresh).toHaveBeenCalledTimes(1));
      expect(shell.refetchAgents).toHaveBeenCalledTimes(1);
    });

    it("shows an agent of the person's own with what it runs on and no model to change", () => {
      state.agentId = "bot_custom001";
      state.statuses = customStatuses;
      openDetails();

      expect(screen.getByText("Runs on Pi · Claude Sonnet 5 via Matrix AI")).toBeTruthy();
      expect(screen.queryByRole("header", { name: "Model" })).toBeNull();
      expect(screen.queryByRole("header", { name: "Apps" })).toBeNull();
      expect(screen.getByRole("button", { name: "Archive agent" })).toBeTruthy();
    });

    it("offers no archive for an agent that is not in the list", () => {
      state.agentId = "bot_unknown01";
      state.statuses = { bot_unknown01: { state: "idle", label: "No open tasks", chatId: "chat_unknown", lastActivityAt: null } };
      state.botSnapshot = null;
      openDetails();

      expect(within(screen.getByTestId("expo-bottom-sheet")).getByRole("header", { name: "Agent" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Archive agent" })).toBeNull();
    });

    it("draws none of the controls the server has nothing behind", () => {
      state.botSnapshot = snapshot({ interactions: [approval] });
      openDetails();

      for (const label of ["Edit", "Pause agent", "Always allow"]) {
        expect(screen.queryByRole("button", { name: label })).toBeNull();
      }
      expect(screen.queryByRole("header", { name: "Schedule" })).toBeNull();
      expect(screen.queryByText(/Runs before each meeting/)).toBeNull();
      expect(screen.queryByText("Set when the agent was created")).toBeNull();
    });
  });

  describe("archiving", () => {
    function askToArchive() {
      openDetails();
      fireEvent.press(screen.getByRole("button", { name: "Archive agent" }));
    }

    it("asks first, saying that it cannot be undone from the app", () => {
      askToArchive();

      expect(alert).toHaveBeenCalledTimes(1);
      expect(alert.mock.calls[0][0]).toBe("Archive Account research?");
      expect(alert.mock.calls[0][1]).toBe("It leaves your agents list. This cannot be undone from the app.");
      expect((alert.mock.calls[0][2] as AlertButton[]).map((button) => button.text)).toEqual(["Cancel", "Archive"]);
      expect(alertButton("Cancel").style).toBe("cancel");
      expect(shell.archive).not.toHaveBeenCalled();
    });

    it("archives nothing when the question is cancelled", () => {
      askToArchive();

      act(() => alertButton("Cancel").onPress?.());

      expect(shell.archive).not.toHaveBeenCalled();
      expect(sheet.isPresented).toBe(true);
    });

    it("archives the agent at the revision on screen, then closes the sheet and returns to the Agents list", async () => {
      let confirm: () => void = () => {};
      shell.archive.mockReturnValue(new Promise<void>((resolve) => { confirm = resolve; }));
      askToArchive();

      act(() => alertButton("Archive").onPress?.());

      expect(shell.archive).toHaveBeenCalledWith({ agentId: "bot_research1", baseRevision: 7 });
      // Nothing moves until the server confirms.
      expect(sheet.isPresented).toBe(true);
      expect(router.dismissAll).not.toHaveBeenCalled();

      await act(async () => confirm());

      expect(sheet.isPresented).toBe(false);
      expect(router.dismissAll).toHaveBeenCalledTimes(1);
      expect(router.replace).not.toHaveBeenCalled();
      expect(alert).toHaveBeenCalledTimes(1);
    });

    it("goes to the Agents list when there is no screen under this one to return to", async () => {
      router.canDismiss.mockReturnValue(false);
      shell.archive.mockResolvedValue(undefined);
      askToArchive();

      await act(async () => alertButton("Archive").onPress?.());

      expect(router.dismissAll).not.toHaveBeenCalled();
      expect(router.replace).toHaveBeenCalledWith("/agents");
    });

    it("says the agent changed when the server refuses the revision, and stays where it is", async () => {
      shell.archive.mockRejectedValue(new AgentRequestError("conflict"));
      askToArchive();

      await act(async () => alertButton("Archive").onPress?.());

      expect(alert).toHaveBeenCalledTimes(2);
      expect(alert.mock.calls[1][0]).toBe("This agent changed. Try again.");
      expect(sheet.isPresented).toBe(true);
      expect(router.dismissAll).not.toHaveBeenCalled();
      expect(router.replace).not.toHaveBeenCalled();
    });

    it.each([
      ["the agent is already gone", new AgentRequestError("not_found")],
      ["the computer cannot be reached", new Error("upstream said no")],
    ])("shows a generic alert when %s", async (_case, failure) => {
      shell.archive.mockRejectedValue(failure);
      askToArchive();

      await act(async () => alertButton("Archive").onPress?.());

      expect(alert).toHaveBeenCalledTimes(2);
      expect(alert.mock.calls[1].slice(0, 2)).toEqual(["Agent could not be archived", "Try again."]);
      expect(JSON.stringify([alert.mock.calls, warn.mock.calls])).not.toContain("upstream said no");
      expect(sheet.isPresented).toBe(true);
      expect(router.dismissAll).not.toHaveBeenCalled();
    });

    it("shows the request in flight on the button, which then asks nothing more", () => {
      state.archivePending = true;
      openDetails();

      const archive = screen.getByRole("button", { name: "Archive agent" });
      expect(archive.props.accessibilityState).toMatchObject({ busy: true, disabled: true });
      fireEvent.press(archive);

      expect(alert).not.toHaveBeenCalled();
    });
  });
});
