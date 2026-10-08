import { cleanup, fireEvent, render, screen } from "@testing-library/react-native";

import * as mockLayout from "./drawer-layout-test-utils";
import { C2_CHATS, chatRecord, chatRows, search } from "./side-panel-test-utils";
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

const { mocks, chatPages } = mockLayout;

const AGENT_CHAT = chatRecord({ id: "chat-agent", title: "Inbox agent", lastMessagePreview: "Sorted 12 emails" });
const AGENTS = [{ id: "agent-1", recipeRef: { id: "inbox" } }];

describe("side panel layout: the chats it lists", () => {
  beforeEach(mockLayout.resetDrawerLayout);

  afterEach(() => {
    cleanup();
    jest.useRealTimers();
  });

  describe("agent chats", () => {
    beforeEach(() => {
      mocks.useCanonicalChatPages.mockReturnValue(chatPages({ chats: [AGENT_CHAT, ...C2_CHATS] }));
      mocks.useAgents.mockReturnValue({ agents: AGENTS });
    });

    it("reads the status of the saved agents to learn which chats are theirs", () => {
      render(<DrawerLayout />);

      expect(mocks.useAgentStatuses).toHaveBeenCalledWith(AGENTS);
    });

    it("leaves an agent's own chat out of the list", () => {
      mocks.useAgentStatuses.mockReturnValue({ statuses: { "agent-1": { chatId: "chat-agent" } } });
      render(<DrawerLayout />);

      expect(chatRows()).toEqual([
        "side-panel-chat-chat-weekly", "side-panel-chat-chat-sales", "side-panel-chat-chat-q4",
      ]);
      expect(screen.queryByText("Inbox agent")).toBeNull();
    });

    it("lists every chat while the agents' chats are not known yet", () => {
      mocks.useAgentStatuses.mockReturnValue({ statuses: { "agent-1": { chatId: null } } });
      render(<DrawerLayout />);

      expect(chatRows()).toContain("side-panel-chat-chat-agent");
      expect(chatRows()).toHaveLength(4);
    });

    it("leaves an agent's chat out of search results too", () => {
      jest.useFakeTimers();
      mocks.useAgentStatuses.mockReturnValue({ statuses: { "agent-1": { chatId: "chat-agent" } } });
      mocks.useChatSearch.mockImplementation((query: string) => ({
        results: query ? [AGENT_CHAT, chatRecord({ id: "chat-budget", title: "Budget review" })] : [],
        isSearching: false,
        isError: false,
      }));
      render(<DrawerLayout />);

      search("agent");

      expect(chatRows()).toEqual(["side-panel-chat-chat-budget"]);
    });
  });

  describe("search", () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    it("searches nothing until a query has been typed", () => {
      render(<DrawerLayout />);

      expect(mocks.useChatSearch).toHaveBeenLastCalledWith("");
    });

    it("searches the server for the typed query and lists its results after the title matches", () => {
      mocks.useChatSearch.mockImplementation((query: string) => ({
        results: query === "plan" ? [C2_CHATS[2], chatRecord({ id: "chat-budget", title: "Budget review" })] : [],
        isSearching: false,
        isError: false,
      }));
      render(<DrawerLayout />);

      search(" plan ");

      expect(mocks.useChatSearch).toHaveBeenLastCalledWith("plan");
      expect(chatRows()).toEqual(["side-panel-chat-chat-q4", "side-panel-chat-chat-budget"]);
      expect(screen.queryByText("Recent")).toBeNull();
    });

    it("shows skeleton rows while the server searches, and a generic line when it fails", () => {
      mocks.useChatSearch.mockImplementation((query: string) => ({
        results: [],
        isSearching: query === "zebra",
        isError: query === "broken",
      }));
      render(<DrawerLayout />);

      search("zebra");
      expect(screen.getAllByTestId("recent-chat-skeleton-row")).toHaveLength(3);
      expect(screen.queryByText("No chats found")).toBeNull();

      search("broken");
      expect(screen.queryByTestId("recent-chat-skeleton-row")).toBeNull();
      expect(screen.getByRole("alert").props.children).toBe("Search unavailable. Try again.");

      search("nothing");
      expect(screen.getByText("No chats found")).toBeTruthy();
    });
  });

  describe("older chats", () => {
    it("loads the next page when the list nears its end", () => {
      const pages = chatPages({ hasMore: true });
      mocks.useCanonicalChatPages.mockReturnValue(pages);
      render(<DrawerLayout />);

      fireEvent(screen.getByTestId("side-panel"), "endReached");

      expect(pages.loadMore).toHaveBeenCalledTimes(1);
    });

    it("does not ask again while a page is loading, or when there is no more", () => {
      const loading = chatPages({ hasMore: true, isLoadingMore: true });
      mocks.useCanonicalChatPages.mockReturnValue(loading);
      render(<DrawerLayout />);
      fireEvent(screen.getByTestId("side-panel"), "endReached");
      expect(loading.loadMore).not.toHaveBeenCalled();
      expect(screen.getAllByTestId("recent-chat-skeleton-row")).toHaveLength(3);
      cleanup();

      const complete = chatPages({ hasMore: false });
      mocks.useCanonicalChatPages.mockReturnValue(complete);
      render(<DrawerLayout />);
      fireEvent(screen.getByTestId("side-panel"), "endReached");
      expect(complete.loadMore).not.toHaveBeenCalled();
    });

    it("offers to try again when a page could not be loaded", () => {
      const failed = chatPages({ hasMore: true, isLoadMoreError: true });
      mocks.useCanonicalChatPages.mockReturnValue(failed);
      render(<DrawerLayout />);

      fireEvent(screen.getByTestId("side-panel"), "endReached");
      expect(failed.loadMore).not.toHaveBeenCalled();

      fireEvent.press(screen.getByRole("button", { name: "Try again" }));
      expect(failed.loadMore).toHaveBeenCalledTimes(1);
    });
  });
});
