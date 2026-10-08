import { cleanup, fireEvent, screen, within } from "@testing-library/react-native";
import { Alert } from "react-native";
import * as Clipboard from "expo-clipboard";

import { IconTile } from "../components/ui/IconTile";
import { ChatIcon } from "../components/ui/icons";

import { NOW, chatRecord, renderPanel } from "./side-panel-test-utils";
import { flat } from "./ui-test-utils";

describe("SidePanel chats", () => {
  afterEach(() => {
    cleanup();
    jest.restoreAllMocks();
  });

  describe("rows", () => {
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

    it("marks only the chats that need the person with a waiting dot", () => {
      renderPanel();

      const dot = within(screen.getByTestId("side-panel-chat-chat-weekly-title-line")).getByTestId("side-panel-waiting-dot");
      expect(flat(dot)).toMatchObject({ width: 8, height: 8, backgroundColor: "#E0AA52" });
      expect(screen.getAllByTestId("side-panel-waiting-dot")).toHaveLength(1);
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

    it("opens the chat menu on a long press, in either group", () => {
      const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
      const props = renderPanel();

      fireEvent(screen.getByTestId("side-panel-chat-chat-weekly"), "longPress");
      fireEvent(screen.getByTestId("side-panel-chat-chat-q4"), "longPress");

      expect(alert).toHaveBeenCalledTimes(2);
      const copy = alert.mock.calls[1]?.[2]?.find((button) => button.text === "Copy chat ID");
      expect(copy).toBeDefined();
      copy!.onPress?.();
      expect(Clipboard.setStringAsync).toHaveBeenCalledWith("chat-q4");
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
      const [circle, bar] = row.children as Parameters<typeof flat>[0][];
      expect(flat(circle)).toMatchObject({ width: 40, height: 40, borderRadius: 9999, backgroundColor: "#EEF7F2" });
      expect(flat(bar)).toMatchObject({ height: 14, width: "72%", borderRadius: 9999, backgroundColor: "#EEF7F2" });
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
