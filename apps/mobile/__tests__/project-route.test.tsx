import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react-native";

import * as mockRoutes from "./project-route-test-utils";
import ProjectRoute from "../app/(drawer)/(tabs)/(chats)/projects/[projectId]";

jest.mock("@clerk/clerk-expo", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "user_a", getToken: async () => "session-token" }),
}));
jest.mock("@/lib/storage", () => ({ HOSTED_GATEWAY_URL: "https://app.matrix-os.com" }));
jest.mock("@/lib/requests", () => mockRoutes.requestsModule());
jest.mock("expo-router", () => mockRoutes.expoRouterModule());
jest.mock("@expo/ui", () => mockRoutes.sheetModule());
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 62, right: 0, bottom: 34, left: 0 }),
}));
jest.mock("@/lib/use-keyboard-visible", () => ({ useKeyboardVisible: () => false }));
jest.mock("@/lib/canonical-chat-session-context", () => ({ useCanonicalChatSession: () => mockRoutes.shell }));
jest.mock("@/lib/use-shell-navigation", () => ({ useShowChatScreen: () => mockRoutes.shell.showChatScreen }));
jest.mock("@/lib/use-session-token-warmup", () => ({
  useSessionTokenWarmup: () => mockRoutes.shell.warmSessionToken,
}));
jest.mock("@/components/ModelPicker", () => ({
  ModelPicker: (props: unknown) => {
    mockRoutes.shell.modelPicker(props);
    return null;
  },
}));

// The reanimated mock in jest.setup.js has no `cancelAnimation`, which the
// skeleton rows call when they unmount.
const reanimated = jest.requireMock<{ cancelAnimation?: unknown }>("react-native-reanimated");
reanimated.cancelAnimation ??= jest.fn();

const {
  requests, router, route, shell, portfolio, catalog, sonnet, opus, caseStudy, landing, pricing,
  GATEWAY_URL, TOKEN, pendingRequest, chatTitles, modelPickerProps,
} = mockRoutes;

const renderProject = (params?: typeof route.params) => mockRoutes.renderProjectRoute(<ProjectRoute />, params);
const renderPortfolio = () => mockRoutes.renderPortfolio(<ProjectRoute />);

const list = () => screen.getByTestId("project-chats");
const input = () => screen.getByLabelText("Message Matrix");
const sendButton = () => screen.getByRole("button", { name: "Send message" });

describe("project route", () => {
  beforeEach(() => {
    mockRoutes.resetProjectRoute();
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    jest.restoreAllMocks();
  });

  describe("project", () => {
    it("shows skeleton rows until the projects have been read, then the project", async () => {
      const read = pendingRequest<unknown[]>();
      requests.fetchProjects.mockReturnValue(read.promise);
      await renderProject();

      expect(screen.getAllByTestId("project-skeleton-row").length).toBeGreaterThan(0);
      expect(screen.queryByTestId("composer")).toBeNull();

      await act(async () => read.resolve([portfolio]));

      await waitFor(() => expect(screen.getByRole("header", { name: "Portfolio" })).toBeTruthy());
      expect(screen.getByTestId("composer")).toBeTruthy();
    });

    it("heads the screen with the project's name and when it last changed", async () => {
      await renderPortfolio();

      expect(within(screen.getByTestId("project-top-bar")).getByRole("header", { name: "Portfolio" })).toBeTruthy();
      const header = screen.getByTestId("project-header");
      expect(within(header).getAllByText(/./).map((node) => node.props.children)).toEqual(["Portfolio", "Updated today"]);
    });

    it.each<[string, typeof route.params]>([
      ["an id no project has", { projectId: "proj_gone" }],
      ["no id at all", {}],
      ["more than one id", { projectId: ["proj_portfolio", "proj_matrix"] }],
    ])("says the project was not found for %s, and reads no chats", async (_case, params) => {
      await renderProject(params);

      await waitFor(() => expect(screen.getByText("Project not found")).toBeTruthy());
      expect(requests.fetchProjectChats).not.toHaveBeenCalled();
      expect(screen.queryByTestId("composer")).toBeNull();
      expect(screen.queryByRole("button", { name: "Project options" })).toBeNull();
    });

    it("goes back to the list, also when a link opened the project with nothing beneath it", async () => {
      await renderProject({ projectId: "proj_gone" });
      await waitFor(() => expect(screen.getByText("Project not found")).toBeTruthy());

      fireEvent.press(screen.getByRole("button", { name: "Back" }));
      expect(router.back).toHaveBeenCalledTimes(1);

      router.canGoBack.mockReturnValue(false);
      fireEvent.press(screen.getByRole("button", { name: "Back" }));
      expect(router.back).toHaveBeenCalledTimes(1);
      expect(router.replace).toHaveBeenCalledWith("/projects");
    });

    it("says in generic words that the project could not be loaded, and reads again from Try again", async () => {
      requests.fetchProjects.mockRejectedValue(new Error("upstream said no"));
      await renderProject();
      await waitFor(() => expect(screen.getByRole("alert").props.children).toBe("Project could not be loaded."));
      expect(screen.queryByText(/upstream/)).toBeNull();

      requests.fetchProjects.mockResolvedValue([portfolio]);
      fireEvent.press(screen.getByRole("button", { name: "Try again" }));

      await waitFor(() => expect(screen.getByRole("header", { name: "Portfolio" })).toBeTruthy());
    });
  });

  describe("chats", () => {
    it("reads the chats of the project by its id and lists them with their last message and time", async () => {
      await renderPortfolio();

      expect(requests.fetchProjectChats).toHaveBeenCalledWith(TOKEN, GATEWAY_URL, "proj_portfolio", { cursor: undefined });
      const row = screen.getByTestId("project-chat-chat_case");
      expect(within(row).getAllByText(/./).map((node) => node.props.children)).toEqual([
        "Case study",
        "Draft ready to review",
        "2h",
      ]);
    });

    it("shows skeleton rows under the header while the chats are read", async () => {
      requests.fetchProjectChats.mockReturnValue(pendingRequest().promise);
      await renderProject();

      await waitFor(() => expect(screen.getByTestId("project-header")).toBeTruthy());
      expect(screen.getByTestId("recent-chat-skeleton")).toBeTruthy();
      expect(chatTitles()).toEqual([]);
    });

    it("says the project has no chats yet", async () => {
      requests.fetchProjectChats.mockResolvedValue({ items: [] });
      await renderProject();

      await waitFor(() => expect(screen.getByText("No chats in this project yet")).toBeTruthy());
    });

    it("says in generic words that the chats could not be loaded, and reads them again from Try again", async () => {
      requests.fetchProjectChats.mockRejectedValue(new Error("upstream said no"));
      await renderProject();
      await waitFor(() => expect(screen.getByRole("alert").props.children).toBe("Chats could not be loaded."));
      expect(screen.queryByText(/upstream/)).toBeNull();

      requests.fetchProjectChats.mockResolvedValue({ items: [caseStudy] });
      fireEvent.press(screen.getByRole("button", { name: "Try again" }));

      await waitFor(() => expect(chatTitles()).toEqual(["Case study"]));
      expect(list().props.refreshing).toBe(false);
    });

    it("loads the next page as the list nears its end, and stops once there is none", async () => {
      requests.fetchProjectChats.mockResolvedValueOnce({ items: [caseStudy, landing], nextCursor: "page-2" });
      requests.fetchProjectChats.mockResolvedValueOnce({ items: [pricing] });
      await renderPortfolio();

      fireEvent(list(), "endReached");

      await waitFor(() => expect(chatTitles()).toEqual(["Case study", "Landing page copy", "Pricing page"]));
      expect(requests.fetchProjectChats).toHaveBeenLastCalledWith(TOKEN, GATEWAY_URL, "proj_portfolio", { cursor: "page-2" });
      expect(screen.queryByRole("button", { name: "Load more chats" })).toBeNull();

      fireEvent(list(), "endReached");
      expect(requests.fetchProjectChats).toHaveBeenCalledTimes(2);
    });

    it("keeps Load more in reach when a page comes back empty while the server has more", async () => {
      requests.fetchProjectChats.mockResolvedValueOnce({ items: [], nextCursor: "page-2" });
      requests.fetchProjectChats.mockResolvedValueOnce({ items: [pricing] });
      await renderProject();
      await waitFor(() => expect(screen.getByRole("button", { name: "Load more chats" })).toBeTruthy());
      expect(screen.queryByText("No chats in this project yet")).toBeNull();

      fireEvent.press(screen.getByRole("button", { name: "Load more chats" }));

      await waitFor(() => expect(chatTitles()).toEqual(["Pricing page"]));
    });

    it("says a further page could not be loaded and loads it again from Try again", async () => {
      requests.fetchProjectChats.mockResolvedValueOnce({ items: [caseStudy, landing], nextCursor: "page-2" });
      requests.fetchProjectChats.mockRejectedValueOnce(new Error("upstream said no"));
      requests.fetchProjectChats.mockResolvedValueOnce({ items: [pricing] });
      await renderPortfolio();

      fireEvent(list(), "endReached");
      await waitFor(() => expect(screen.getByRole("alert").props.children).toBe("Older chats could not be loaded."));
      expect(chatTitles()).toEqual(["Case study", "Landing page copy"]);

      fireEvent.press(screen.getByRole("button", { name: "Try again" }));

      await waitFor(() => expect(chatTitles()).toEqual(["Case study", "Landing page copy", "Pricing page"]));
    });

    it("opens the chat whose row is pressed on the chat screen", async () => {
      await renderPortfolio();

      fireEvent.press(screen.getByTestId("project-chat-chat_landing"));

      expect(shell.selectChat).toHaveBeenCalledWith("chat_landing");
      expect(shell.showChatScreen).toHaveBeenCalledTimes(1);
      expect(shell.setSelectionOverride).not.toHaveBeenCalled();
    });

    it("reads the projects and the chats again on pull to refresh, with the spinner until both have answered", async () => {
      await renderPortfolio();
      const chatsRead = pendingRequest<unknown>();
      requests.fetchProjectChats.mockReturnValue(chatsRead.promise);

      fireEvent(list(), "refresh");
      await waitFor(() => expect(list().props.refreshing).toBe(true));
      await waitFor(() => expect(requests.fetchProjects).toHaveBeenCalledTimes(2));
      expect(requests.fetchProjectChats).toHaveBeenCalledTimes(2);

      await act(async () => chatsRead.resolve({ items: [pricing] }));
      await waitFor(() => expect(list().props.refreshing).toBe(false));
      expect(chatTitles()).toEqual(["Pricing page"]);
    });
  });

  describe("composer", () => {
    const created = { chat: { id: "chat_new", revision: 0 }, projectId: "proj_portfolio" };
    const admission = { message: { id: "msg_1" } };

    it("asks for a new chat in the project and wires the model picker as the chat screen does", async () => {
      await renderPortfolio();

      expect(input().props.placeholder).toBe("New chat in Portfolio");
      expect(modelPickerProps()).toMatchObject({ catalog, catalogLoading: false, selection: sonnet });
    });

    it("tells the model picker that the models are still being checked, and holds sends until they are known", async () => {
      requests.fetchChatProviderCatalog.mockReturnValue(pendingRequest().promise);
      await renderProject();
      await waitFor(() => expect(chatTitles()).toEqual(["Case study", "Landing page copy"]));

      expect(modelPickerProps()).toMatchObject({ catalog: null, catalogLoading: true, selection: null });
      fireEvent.changeText(input(), "Draft the case study");
      expect(sendButton().props.accessibilityState).toMatchObject({ disabled: true });
      fireEvent(input(), "submitEditing");

      expect(requests.createChat).not.toHaveBeenCalled();
    });

    it("warms the session token when the box is focused or typed in", async () => {
      await renderPortfolio();

      fireEvent(input(), "focus");
      fireEvent.changeText(input(), "D");

      expect(shell.warmSessionToken).toHaveBeenCalledTimes(2);
    });

    it("cannot send a blank message", async () => {
      await renderPortfolio();

      fireEvent.changeText(input(), "   ");
      expect(sendButton().props.accessibilityState).toMatchObject({ disabled: true });
      fireEvent(input(), "submitEditing");

      expect(requests.createChat).not.toHaveBeenCalled();
    });

    it("starts a chat in the project with the message, then shows it on the chat screen", async () => {
      const admitted = pendingRequest<typeof admission>();
      requests.createChat.mockResolvedValue(created);
      requests.admitChatTurn.mockReturnValue(admitted.promise);
      await renderPortfolio();

      fireEvent.changeText(input(), "  Draft the case study ");
      fireEvent.press(sendButton());

      await waitFor(() => expect(requests.admitChatTurn).toHaveBeenCalledTimes(1));
      expect(requests.createChat).toHaveBeenCalledWith(TOKEN, GATEWAY_URL, {
        clientRequestId: expect.stringMatching(/^req_/),
        title: "Draft the case study",
        currentSelection: sonnet,
        projectId: "proj_portfolio",
      });
      expect(requests.admitChatTurn).toHaveBeenCalledWith(TOKEN, GATEWAY_URL, "chat_new", expect.objectContaining({
        parts: [{ type: "text", text: "Draft the case study" }],
        selection: sonnet,
        interactionMode: "default",
        permissionMode: "supervised",
      }));
      // Until the server has the message it stays in the box and nothing moves.
      expect(input().props.value).toBe("  Draft the case study ");
      expect(screen.getByRole("button", { name: "Stop" }).props.accessibilityState).toMatchObject({ disabled: true });
      expect(shell.showChatScreen).not.toHaveBeenCalled();

      await act(async () => admitted.resolve(admission));

      await waitFor(() => expect(shell.showChatScreen).toHaveBeenCalledTimes(1));
      expect(shell.bindDraftChatId).toHaveBeenCalledWith("chat_new");
      expect(shell.setSelectionOverride).toHaveBeenCalledWith(sonnet);
      expect(input().props.value).toBe("");
    });

    it("keeps the message in the box and stays on the project when the chat could not be started", async () => {
      requests.createChat.mockRejectedValue(new Error("upstream said no"));
      await renderPortfolio();

      fireEvent.changeText(input(), "Draft the case study");
      fireEvent.press(sendButton());

      await waitFor(() => expect(requests.createChat).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(sendButton()).toBeTruthy());
      expect(input().props.value).toBe("Draft the case study");
      expect(shell.showChatScreen).not.toHaveBeenCalled();
      expect(shell.setSelectionOverride).not.toHaveBeenCalled();
      expect(screen.queryByText(/upstream/)).toBeNull();
    });

    it("sends the same message again under the request ids of the attempt that failed", async () => {
      requests.createChat.mockResolvedValue(created);
      requests.admitChatTurn.mockRejectedValueOnce(new Error("upstream said no"));
      requests.admitChatTurn.mockResolvedValueOnce(admission);
      await renderPortfolio();
      fireEvent.changeText(input(), "Draft the case study");

      fireEvent.press(sendButton());
      await waitFor(() => expect(requests.admitChatTurn).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(sendButton().props.accessibilityState).toMatchObject({ disabled: false }));
      fireEvent.press(sendButton());
      await waitFor(() => expect(shell.showChatScreen).toHaveBeenCalledTimes(1));

      const [first, second] = requests.createChat.mock.calls.map(([, , body]) => (body as { clientRequestId: string }).clientRequestId);
      expect(second).toBe(first);
      const [firstTurn, secondTurn] = requests.admitChatTurn.mock.calls
        .map(([, , , body]) => (body as { clientRequestId: string }).clientRequestId);
      expect(secondTurn).toBe(firstTurn);
    });

    it("keeps the model chosen here to itself until a chat is started with it", async () => {
      requests.createChat.mockResolvedValue(created);
      requests.admitChatTurn.mockResolvedValue(admission);
      await renderPortfolio();

      act(() => modelPickerProps().onSelectionChange(opus));

      expect(modelPickerProps().selection).toEqual(opus);
      expect(shell.setSelectionOverride).not.toHaveBeenCalled();

      fireEvent.changeText(input(), "Draft the case study");
      fireEvent.press(sendButton());

      await waitFor(() => expect(shell.setSelectionOverride).toHaveBeenCalledWith(opus));
      expect(requests.createChat).toHaveBeenCalledWith(TOKEN, GATEWAY_URL, expect.objectContaining({ currentSelection: opus }));
    });

    it("leaves the person where they are when they left the project before the chat was started", async () => {
      const admitted = pendingRequest<typeof admission>();
      requests.createChat.mockResolvedValue(created);
      requests.admitChatTurn.mockReturnValue(admitted.promise);
      await renderPortfolio();
      fireEvent.changeText(input(), "Draft the case study");
      fireEvent.press(sendButton());
      await waitFor(() => expect(requests.admitChatTurn).toHaveBeenCalledTimes(1));

      route.focused = false;
      await act(async () => admitted.resolve(admission));

      await waitFor(() => expect(shell.setSelectionOverride).toHaveBeenCalledWith(sonnet));
      expect(shell.showChatScreen).not.toHaveBeenCalled();
    });
  });
});
