import { cleanup, fireEvent, render, screen, within } from "@testing-library/react-native";
import * as Haptics from "expo-haptics";
import { Keyboard } from "react-native";

import * as mockLayout from "./drawer-layout-test-utils";
import { chatRows } from "./side-panel-test-utils";
import DrawerLayout from "../app/(drawer)/_layout";

jest.mock("@clerk/clerk-expo", () => ({ useAuth: () => ({ getToken: async () => "clerk-token" }) }));
jest.mock("@/lib/requests/collaboration", () => ({
  fetchCollaborationInbox: () => mockLayout.mocks.fetchCollaborationInbox(),
}));
jest.mock("@/lib/queries/use-canonical-chats", () => ({
  useCanonicalChatPages: () => mockLayout.mocks.useCanonicalChatPages(),
}));
jest.mock("@/lib/queries/use-projects", () => ({ useProjects: () => mockLayout.mocks.useProjects() }));
jest.mock("@/lib/queries/use-agents", () => ({ useAgents: () => mockLayout.mocks.useAgents() }));
jest.mock("@/lib/queries/use-agent-statuses", () => ({
  useAgentStatuses: (agents: unknown) => mockLayout.mocks.useAgentStatuses(agents),
}));
jest.mock("@/lib/queries/use-chat-search", () => ({
  useChatSearch: (query: string) => mockLayout.mocks.useChatSearch(query),
}));
jest.mock("@/lib/canonical-chat-session-context", () => ({
  useCanonicalChatSession: () => ({
    activeChatId: "chat-sales",
    selectChat: mockLayout.mocks.selectChat,
    startDraftChat: mockLayout.mocks.startDraftChat,
  }),
}));
jest.mock("@/lib/queries/use-settings-system-info", () => ({
  useSettingsSystemInfo: () => mockLayout.mocks.useSettingsSystemInfo(),
}));
jest.mock("expo-router", () => ({ useSegments: () => mockLayout.drawer.segments }));
jest.mock("expo-router/drawer", () => mockLayout.drawerModule());

const { drawer, mocks, chatPages } = mockLayout;

const SHOW_CHAT_SCREEN = ["(tabs)", { screen: "(chats)", params: { screen: "index" } }];
const SHOW_SHARED_SCREEN = ["(tabs)", { screen: "(chats)", params: { screen: "shared" } }];
const SHOW_PROJECTS_SCREEN = ["(tabs)", { screen: "(chats)", params: { screen: "projects/index" } }];

describe("side panel layout", () => {
  beforeEach(mockLayout.resetDrawerLayout);
  afterEach(cleanup);

  describe("drawer", () => {
    it("holds the tabs as its only screen, without a header", () => {
      render(<DrawerLayout />);

      expect(drawer.screens).toEqual(["(tabs)"]);
      expect(drawer.options).toMatchObject({ headerShown: false, drawerPosition: "left" });
      expect(drawer.options?.headerLeft).toBeUndefined();
    });

    it("slides a 330pt panel over the screen, which stays put under the scrim", () => {
      render(<DrawerLayout />);

      expect(drawer.options).toMatchObject({
        drawerType: "front",
        overlayColor: "rgba(0, 0, 0, 0.3)",
        overlayAccessibilityLabel: "Close side panel",
        sceneStyle: { backgroundColor: "#FFFEFC" },
      });
      expect(drawer.options?.drawerStyle).toEqual({
        width: 330,
        backgroundColor: "#FFFEFC",
        boxShadow: "8px 0 24px rgba(0, 0, 0, 0.12)",
        borderTopRightRadius: 0,
        borderBottomRightRadius: 0,
      });
    });

    it("plays a medium haptic when the panel opens and closes", () => {
      render(<DrawerLayout />);

      drawer.listeners?.drawerOpen?.();
      expect(Haptics.impactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Medium);
      drawer.listeners?.drawerClose?.();
      expect(Haptics.impactAsync).toHaveBeenCalledTimes(2);
    });

    it("puts the keyboard away when the panel closes, so the search field does not leave it up", () => {
      const dismiss = jest.spyOn(Keyboard, "dismiss").mockImplementation(() => undefined);
      render(<DrawerLayout />);
      expect(dismiss).not.toHaveBeenCalled();

      drawer.status = "open";
      screen.rerender(<DrawerLayout />);
      expect(dismiss).not.toHaveBeenCalled();

      drawer.status = "closed";
      screen.rerender(<DrawerLayout />);
      expect(dismiss).toHaveBeenCalledTimes(1);
      dismiss.mockRestore();
    });

    it("opens by swipe only while the chat screen is focused", () => {
      render(<DrawerLayout />);
      expect(drawer.options).toMatchObject({ swipeEnabled: true, swipeEdgeWidth: 800 });

      for (const segments of [
        ["(drawer)", "(tabs)", "(chats)", "shared"],
        ["(drawer)", "(tabs)", "(chats)", "projects"],
        ["(drawer)", "(tabs)", "agents"],
        ["(drawer)", "(tabs)", "(apps)", "apps"],
        ["(drawer)", "(tabs)", "(apps)", "files"],
        ["(drawer)", "(tabs)", "terminal"],
        ["(drawer)", "(tabs)", "settings"],
        ["file-browser"],
        [],
      ]) {
        cleanup();
        drawer.segments = segments;
        render(<DrawerLayout />);
        expect(drawer.options?.swipeEnabled).toBe(false);
      }
    });
  });

  describe("chats", () => {
    it("lists the chats in their groups, without the old header or tree", () => {
      render(<DrawerLayout />);

      expect(screen.getAllByRole("header").map((header) => header.props.children)).toEqual([
        "Chats", "Needs you", "Recent",
      ]);
      expect(chatRows()).toEqual([
        "side-panel-chat-chat-weekly", "side-panel-chat-chat-sales", "side-panel-chat-chat-q4",
      ]);
      expect(screen.queryByText("Matrix OS")).toBeNull();
      for (const label of ["Files", "Terminal", "Connect Apps", "Apps", "Settings"]) {
        expect(screen.queryByLabelText(label)).toBeNull();
      }
    });

    it("shows skeleton rows while the chats load", () => {
      mocks.useCanonicalChatPages.mockReturnValue(chatPages({ chats: [], isPending: true }));
      render(<DrawerLayout />);

      expect(screen.getAllByTestId("recent-chat-skeleton-row")).toHaveLength(3);
      expect(chatRows()).toEqual([]);
    });

    it("shows a generic line when the chats could not be loaded", () => {
      mocks.useCanonicalChatPages.mockReturnValue(chatPages({ chats: [], isError: true }));
      render(<DrawerLayout />);

      expect(screen.getByRole("alert").props.children).toBe("Chats unavailable. Try again.");
    });

    it("selects the pressed chat, shows the chat screen and closes the panel", () => {
      render(<DrawerLayout />);

      fireEvent.press(screen.getByTestId("side-panel-chat-chat-q4"));

      expect(mocks.selectChat).toHaveBeenCalledWith("chat-q4");
      expect(mocks.navigate).toHaveBeenCalledWith(...SHOW_CHAT_SCREEN);
      expect(mocks.closeDrawer).toHaveBeenCalledTimes(1);
    });

    it("starts a draft chat from New chat, shows the chat screen and closes the panel", () => {
      render(<DrawerLayout />);

      fireEvent.press(screen.getByRole("button", { name: "New chat" }));

      expect(mocks.startDraftChat).toHaveBeenCalledWith();
      expect(mocks.selectChat).not.toHaveBeenCalled();
      expect(mocks.navigate).toHaveBeenCalledWith(...SHOW_CHAT_SCREEN);
      expect(mocks.closeDrawer).toHaveBeenCalledTimes(1);
    });

    it("hands the navigator new params on every press, because it ignores ones it has used", () => {
      render(<DrawerLayout />);

      fireEvent.press(screen.getByTestId("side-panel-chat-chat-q4"));
      fireEvent.press(screen.getByRole("button", { name: "New chat" }));
      fireEvent.press(screen.getByTestId("side-panel-projects"));
      fireEvent.press(screen.getByTestId("side-panel-projects"));

      const [chat, newChat, projects, projectsAgain] = mocks.navigate.mock.calls;
      expect(chat[1]).not.toBe(newChat[1]);
      expect(chat[1].params).not.toBe(newChat[1].params);
      expect(projects[1]).not.toBe(projectsAgain[1]);
      expect(projects[1].params).not.toBe(projectsAgain[1].params);
    });
  });

  describe("destinations", () => {
    it("shows how many projects there are, opens Projects and closes the panel", () => {
      render(<DrawerLayout />);

      fireEvent.press(screen.getByRole("button", { name: "Projects, 3 projects" }));

      expect(mocks.navigate).toHaveBeenCalledWith(...SHOW_PROJECTS_SCREEN);
      expect(mocks.closeDrawer).toHaveBeenCalledTimes(1);
    });

    it("shows no project count while the projects load, or when they could not be loaded", () => {
      mocks.useProjects.mockReturnValue({ projects: [], isPending: true, isError: false });
      render(<DrawerLayout />);
      expect(screen.getByRole("button", { name: "Projects" })).toBeTruthy();
      cleanup();

      mocks.useProjects.mockReturnValue({ projects: [], isPending: false, isError: true });
      render(<DrawerLayout />);
      expect(screen.getByRole("button", { name: "Projects" })).toBeTruthy();
      cleanup();

      mocks.useProjects.mockReturnValue({ projects: [], isPending: false, isError: false });
      render(<DrawerLayout />);
      expect(screen.getByRole("button", { name: "Projects, 0 projects" })).toBeTruthy();
    });

    it("shows Shared with me only when the computer advertises collaboration", () => {
      render(<DrawerLayout />);
      expect(screen.queryByLabelText(/Shared with me/)).toBeNull();
      expect(mocks.fetchCollaborationInbox).not.toHaveBeenCalled();
      cleanup();

      mocks.useSettingsSystemInfo.mockReturnValue({ systemInfo: { capabilities: { collaboration: true } } });
      render(<DrawerLayout />);
      fireEvent.press(screen.getByLabelText("Shared with me"));

      expect(mocks.navigate).toHaveBeenCalledWith(...SHOW_SHARED_SCREEN);
      expect(mocks.closeDrawer).toHaveBeenCalledTimes(1);
    });

    it("counts the invitations that are still pending on the Shared with me row", async () => {
      mocks.useSettingsSystemInfo.mockReturnValue({ systemInfo: { capabilities: { collaboration: true } } });
      mocks.fetchCollaborationInbox.mockResolvedValue({
        items: [{ status: "invited" }, { status: "accepted" }, { status: "invited" }],
      });
      render(<DrawerLayout />);

      const row = await screen.findByRole("button", { name: "Shared with me, 2 pending invitations" });
      expect(within(row).getByText("2")).toBeTruthy();
    });
  });
});
