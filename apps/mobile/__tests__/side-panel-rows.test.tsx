import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { AppState } from "react-native";

import * as mockContextMenu from "./context-menu-test-utils";
import { IconTile } from "../components/ui/IconTile";
import { ChatIcon } from "../components/ui/icons";

import { menuAround, menuItem, menuItemLabels } from "./context-menu-test-utils";
import { NOW, chatRecord, renderPanel } from "./side-panel-test-utils";
import { flat } from "./ui-test-utils";

// Jest resolves the iOS files, so each row sits in a native context menu.
jest.mock("@expo/ui/swift-ui", () => mockContextMenu.swiftUiContextMenuModule());

describe("SidePanel chats", () => {
  afterEach(() => {
    cleanup();
    jest.restoreAllMocks();
  });

  describe("rows", () => {
    it("catches dates up when returning from the background", () => {
      jest.useFakeTimers();
      jest.setSystemTime(NOW);
      const listen = jest.spyOn(AppState, "addEventListener");
      try {
        renderPanel({ chats: [chatRecord({ id: "resume", title: "Resume chat", activityAt: new Date(NOW.getTime() - 5 * 60_000).toISOString() })], now: undefined });
        const change = listen.mock.calls.find(([event]) => event === "change")![1];
        expect(within(screen.getByTestId("side-panel-chat-resume")).getByText("5m")).toBeTruthy();
        act(() => change("background"));
        jest.setSystemTime(new Date(NOW.getTime() + 60 * 60_000));
        act(() => change("active"));
        expect(within(screen.getByTestId("side-panel-chat-resume")).getByText("1h")).toBeTruthy();
      } finally {
        cleanup();
        jest.useRealTimers();
      }
    });

    it("keeps the date visible for a pinned Chat and updates it while the panel stays open", () => {
      jest.useFakeTimers();
      jest.setSystemTime(NOW);
      try {
        const pinned = chatRecord({ id: "pinned", title: "Pinned chat", activityAt: new Date(NOW.getTime() - 5 * 60_000).toISOString() });
        pinned.chat.userState = { pinned: true, muted: false, readThroughSeq: 0 };
        renderPanel({ chats: [pinned], now: undefined });
        const row = screen.getByTestId("side-panel-chat-pinned");
        expect(within(row).getByText("5m")).toBeTruthy();
        act(() => jest.advanceTimersByTime(60_000));
        expect(within(row).getByText("6m")).toBeTruthy();
      } finally {
        cleanup();
        jest.useRealTimers();
      }
    });

    it("shows the title, the last message and when the chat was last active", () => {
      renderPanel();

      const row = screen.getByTestId("side-panel-chat-chat-sales");
      expect(within(row).getByText("Sales prep this week")).toBeTruthy();
      expect(within(row).getByText("Both briefs are ready")).toBeTruthy();
      expect(within(row).getByText("Yesterday")).toBeTruthy();
      expect(within(screen.getByTestId("side-panel-chat-chat-weekly")).getByText("1h")).toBeTruthy();
      expect(within(screen.getByTestId("side-panel-chat-chat-q4")).getByText("Mon")).toBeTruthy();
      expect(flat(row).paddingVertical).toBe(10);
    });

    it("dates a chat by its activity time when the server sends one", () => {
      renderPanel({
        chats: [chatRecord({
          id: "a",
          title: "Alpha",
          activityAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
          updatedAt: NOW.toISOString(),
        })],
      });

      expect(within(screen.getByTestId("side-panel-chat-a")).getByText("5m")).toBeTruthy();
    });

    it("falls back to New chat and leaves the preview out when the chat has neither", () => {
      renderPanel({ chats: [chatRecord({ id: "a", title: "  ", lastMessagePreview: "  ", updatedAt: NOW.toISOString() })] });

      const row = screen.getByRole("button", { name: "New chat, now" });
      expect(within(row).getAllByText(/.+/).map((text) => text.props.children)).toEqual(["New chat", "now"]);
    });

    it("shows a preview that runs over several lines on one", () => {
      renderPanel({ chats: [chatRecord({ id: "a", title: "Alpha", lastMessagePreview: "First line\n\n  second line" })] });

      expect(within(screen.getByTestId("side-panel-chat-a")).getByText("First line second line")).toBeTruthy();
    });

    it("marks only the chats that have a status, with an amber dot and the status in place of the last message", () => {
      renderPanel();

      const row = screen.getByTestId("side-panel-chat-chat-weekly");
      // As on Desktop, the dot sits right of the time, not after the title.
      const dot = within(screen.getByTestId("side-panel-chat-chat-weekly-meta")).getByTestId("side-panel-status-dot");
      expect(within(screen.getByTestId("side-panel-chat-chat-weekly-title-line")).queryByTestId("side-panel-status-dot")).toBeNull();
      expect(flat(dot)).toMatchObject({ width: 8, height: 8, backgroundColor: "#E0AA52" });
      expect(screen.getAllByTestId("side-panel-status-dot")).toHaveLength(1);
      expect(within(row).getAllByText(/./).map((node) => node.props.children)).toEqual([
        "Weekly report", "Approval required", "1h",
      ]);
    });

    it("shows a working chat with a green dot and Working…, and an unread finished one as Completed", () => {
      const working = { ...chatRecord({ id: "a", title: "Alpha", lastMessagePreview: "Reading files" }),
        activeRun: { runId: "run_1", turnId: "turn_1", status: "running" as const } };
      const finished = { ...chatRecord({ id: "b", title: "Beta", lastMessagePreview: "All done" }),
        readState: { unread: true, markedUnread: false, version: 1, readThroughSeq: 1, latestIncomingSeq: 2 } };
      renderPanel({ chats: [working, finished] });

      const workingRow = screen.getByTestId("side-panel-chat-a");
      expect(within(workingRow).getByText("Working…")).toBeTruthy();
      expect(within(workingRow).queryByText("Reading files")).toBeNull();
      expect(flat(within(workingRow).getByTestId("side-panel-status-dot")).backgroundColor).toBe("#288A5B");
      expect(workingRow.props.accessibilityLabel).toBe("Alpha, Working…, Reading files, Jan 1");

      const finishedRow = screen.getByTestId("side-panel-chat-b");
      expect(within(finishedRow).getByText("Completed")).toBeTruthy();
      expect(flat(within(finishedRow).getByTestId("side-panel-status-dot")).backgroundColor).toBe("#242323");
      // Neither waits on the person, so both stay under Recent.
      expect(screen.queryByTestId("side-panel-needs-you")).toBeNull();
    });

    it("leads each row with a 40pt round chat tile in the subtle tone", () => {
      renderPanel();

      const tiles = screen.UNSAFE_getAllByType(IconTile);
      expect(tiles).toHaveLength(3);
      for (const tile of tiles) {
        expect(tile.props).toMatchObject({ icon: ChatIcon, size: 40, shape: "circle", tone: "subtle" });
      }
      expect(flat(screen.getByTestId("side-panel-chat-chat-q4-leading")).marginRight).toBe(12);
    });

    it("selects the chat that is pressed", () => {
      const props = renderPanel();

      fireEvent.press(screen.getByTestId("side-panel-chat-chat-q4"));

      expect(props.onSelectChat).toHaveBeenCalledTimes(1);
      expect(props.onSelectChat).toHaveBeenCalledWith("chat-q4");
    });

    it("opens the chat menu on a long press, in either group", async () => {
      const props = renderPanel();

      for (const id of ["chat-weekly", "chat-q4"]) {
        expect(menuItemLabels(menuAround(screen.getByTestId(`side-panel-chat-${id}`)))).toEqual(["Copy chat ID"]);
      }
      fireEvent(screen.getByTestId("side-panel-chat-chat-q4"), "longPress");
      expect(Haptics.impactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Medium);

      fireEvent.press(menuItem(screen.getByTestId("side-panel-chat-chat-q4"), "Copy chat ID"));
      await waitFor(() => expect(Clipboard.setStringAsync).toHaveBeenCalledWith("chat-q4"));
      expect(props.onSelectChat).not.toHaveBeenCalled();
    });
  });

  describe("states", () => {
    it("shows three skeleton rows under Recent while the chats load", () => {
      renderPanel({ chats: [], chatsLoading: true });

      expect(screen.getByText("Recent")).toBeTruthy();
      expect(screen.getAllByTestId("recent-chat-skeleton-row")).toHaveLength(3);
      expect(screen.queryByTestId(/^side-panel-chat-/)).toBeNull();
      expect(screen.queryByText("No chats yet")).toBeNull();
    });

    it("shapes a skeleton row like a chat row: a 40pt circle and a bar, 12pt apart", () => {
      renderPanel({ chats: [], chatsLoading: true });

      const row = screen.getAllByTestId("recent-chat-skeleton-row")[0];
      expect(flat(row)).toMatchObject({ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 });
      // The same placeholder block, and so the same sweep, as every other loading state.
      const circle = screen.getAllByTestId("recent-chat-skeleton-icon")[0];
      const bar = screen.getAllByTestId("recent-chat-skeleton-text")[0];
      expect(flat(circle)).toMatchObject({ width: 40, height: 40, borderRadius: 9999, backgroundColor: "#F2F2F0" });
      expect(flat(bar)).toMatchObject({ height: 14, width: "72%", borderRadius: 9999, backgroundColor: "#F2F2F0" });
      expect(flat(screen.getByTestId("recent-chat-skeleton")).gap).toBe(4);
    });

    it("says so when there are no chats", () => {
      renderPanel({ chats: [] });

      expect(flat(screen.getByText("No chats yet"))).toMatchObject({
        fontFamily: "Geist_400Regular",
        fontSize: 14,
        lineHeight: 20,
        color: "#635F5F",
        textAlign: "center",
        paddingVertical: 10,
      });
      expect(screen.queryByText("Recent")).toBeNull();
      expect(screen.queryByTestId("recent-chat-skeleton-row")).toBeNull();
      expect(flat(screen.getByTestId("side-panel-blocks")).marginBottom).toBe(16);
    });

    it("shows a generic line when the chats could not be loaded", () => {
      renderPanel({ chats: [], chatsFailed: true });

      expect(screen.getByRole("alert").props.children).toBe("Chats unavailable. Try again.");
      expect(screen.queryByText("No chats yet")).toBeNull();
    });

    it("keeps the chats it has when a refresh fails", () => {
      renderPanel({ chatsFailed: true });

      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByTestId("side-panel-chat-chat-q4")).toBeTruthy();
    });
  });
});
