import { cleanup, fireEvent, render, screen, within } from "@testing-library/react-native";
import { StyleSheet as NativeStyleSheet } from "react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";
import UserMultiple02Icon from "@hugeicons/core-free-icons/UserMultiple02Icon";

import { SidePanel } from "../components/shell/SidePanel";
import { Icon } from "../components/ui/Icon";
import { ChevronRightIcon, FolderIcon, NewChatIcon } from "../components/ui/icons";

import { C2_CHATS, chatRecord, renderPanel } from "./side-panel-test-utils";
import { flat, pressedStyle } from "./ui-test-utils";

function buttonLabels() {
  return screen.getAllByRole("button").map((button) => button.props.accessibilityLabel as string);
}

function iconsIn(node: Parameters<typeof within>[0]) {
  return within(node).UNSAFE_getAllByType(Icon).map((icon) => icon.props);
}

describe("SidePanel", () => {
  afterEach(cleanup);

  describe("layout", () => {
    it("fills the panel on the background colour, 8pt under the status bar, with 16pt sides and 24pt below", () => {
      render(
        <SafeAreaInsetsContext.Provider value={{ top: 54, right: 0, bottom: 34, left: 0 }}>
          <SidePanel
            chats={C2_CHATS}
            onSearchQueryChange={jest.fn()}
            onNewChat={jest.fn()}
            onSelectChat={jest.fn()}
            onOpenProjects={jest.fn()}
            onOpenShared={jest.fn()}
          />
        </SafeAreaInsetsContext.Provider>,
      );

      const list = screen.getByTestId("side-panel");
      expect(flat(list)).toMatchObject({ flex: 1, backgroundColor: "#FFFEFC" });
      expect(NativeStyleSheet.flatten(list.props.contentContainerStyle)).toMatchObject({
        paddingTop: 62,
        paddingHorizontal: 16,
        paddingBottom: 24,
      });
    });

    it("stacks its blocks 16pt apart", () => {
      renderPanel();

      expect(flat(screen.getByTestId("side-panel-blocks")).gap).toBe(16);
    });

    it("titles the panel Chats in the heading style", () => {
      renderPanel();

      expect(flat(screen.getByRole("header", { name: "Chats" }))).toMatchObject({
        fontFamily: "Geist_600SemiBold",
        fontSize: 24,
        lineHeight: 34,
        color: "#242323",
      });
    });

    it("has a round, filled 44pt New chat button that starts a new chat", () => {
      const props = renderPanel();

      const button = screen.getByRole("button", { name: "New chat" });
      expect(flat(button)).toMatchObject({ width: 44, height: 44, borderRadius: 9999, backgroundColor: "#FAF9F7" });
      expect(iconsIn(button)[0]).toMatchObject({ icon: NewChatIcon, size: 20 });

      fireEvent.press(button);
      expect(props.onNewChat).toHaveBeenCalledTimes(1);
      expect(props.onNewChat).toHaveBeenCalledWith();
    });

    it("has a Search chats field", () => {
      renderPanel();

      expect(screen.getByLabelText("Search chats").props.placeholder).toBe("Search chats");
    });
  });

  describe("destinations", () => {
    it("draws Projects as a card row: folder, name, count and chevron, 12pt apart", () => {
      renderPanel({ projectCount: 3 });

      const row = screen.getByRole("button", { name: "Projects, 3 projects" });
      expect(flat(row)).toMatchObject({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        padding: 12,
        borderRadius: 12,
        backgroundColor: "#FAF9F7",
      });
      expect(iconsIn(row)).toEqual([
        expect.objectContaining({ icon: FolderIcon, size: 20, color: "#242323" }),
        expect.objectContaining({ icon: ChevronRightIcon, size: 16, color: "#635F5F" }),
      ]);
      expect(flat(within(row).getByText("Projects"))).toMatchObject({
        flex: 1,
        fontFamily: "Geist_500Medium",
        fontSize: 16,
        lineHeight: 22,
        color: "#242323",
      });
      expect(flat(within(row).getByText("3"))).toMatchObject({
        fontFamily: "Geist_400Regular",
        fontSize: 13,
        lineHeight: 18,
        color: "#8A8686",
      });
      expect(pressedStyle({ testID: "side-panel-projects" }).opacity).toBe(0.65);
      const target = (flat(row).padding as number) * 2 + (flat(within(row).getByText("Projects")).lineHeight as number);
      expect(target).toBeGreaterThanOrEqual(44);
    });

    it("counts a single project in the singular and leaves the count out until it is known", () => {
      renderPanel({ projectCount: 1 });
      expect(screen.getByRole("button", { name: "Projects, 1 project" })).toBeTruthy();
      cleanup();

      renderPanel({ projectCount: undefined });
      const row = screen.getByRole("button", { name: "Projects" });
      expect(within(row).queryByText(/^\d+$/)).toBeNull();
    });

    it("opens Projects", () => {
      const props = renderPanel();

      fireEvent.press(screen.getByTestId("side-panel-projects"));

      expect(props.onOpenProjects).toHaveBeenCalledTimes(1);
    });

    it("leaves Shared with me out unless collaboration is on", () => {
      renderPanel({ pendingInvitationCount: 3 });

      expect(screen.queryByLabelText(/Shared with me/)).toBeNull();
      expect(screen.queryByTestId("side-panel-shared")).toBeNull();
    });

    it("lists Shared with me under Projects in the same style, with the pending invitations", () => {
      const props = renderPanel({ collaborationEnabled: true, pendingInvitationCount: 3 });

      expect(buttonLabels().slice(0, 3)).toEqual([
        "New chat",
        "Projects, 3 projects",
        "Shared with me, 3 pending invitations",
      ]);
      const row = screen.getByTestId("side-panel-shared");
      expect(flat(row)).toEqual(flat(screen.getByTestId("side-panel-projects")));
      expect(iconsIn(row).map((icon) => icon.icon)).toEqual([UserMultiple02Icon, ChevronRightIcon]);
      expect(within(screen.getByTestId("side-panel-shared-badge")).getByText("3")).toBeTruthy();

      fireEvent.press(row);
      expect(props.onOpenShared).toHaveBeenCalledTimes(1);
    });

    it("names one pending invitation in the singular and shows no badge for none", () => {
      renderPanel({ collaborationEnabled: true, pendingInvitationCount: 1 });
      expect(screen.getByRole("button", { name: "Shared with me, 1 pending invitation" })).toBeTruthy();
      cleanup();

      renderPanel({ collaborationEnabled: true });
      expect(within(screen.getByRole("button", { name: "Shared with me" })).queryByText(/^\d+$/)).toBeNull();
    });
  });

  describe("groups", () => {
    it("lists the chats that need the person under Needs you, with their count, and the rest under Recent", () => {
      renderPanel();

      expect(screen.getAllByRole("header").map((header) => header.props.children)).toEqual([
        "Chats", "Needs you", "Recent",
      ]);
      expect(within(screen.getByTestId("side-panel-needs-you")).getByText("1")).toBeTruthy();
      expect(screen.getByLabelText("1 chat")).toBeTruthy();
      expect(buttonLabels().slice(2)).toEqual([
        "Weekly report, needs you, Approve before sending, 1h",
        "Sales prep this week, Both briefs are ready, Yesterday",
        "Q4 planning, Draft shared with the team, Mon",
      ]);
    });

    it("counts every chat that needs the person", () => {
      renderPanel({
        chats: [
          chatRecord({ id: "a", title: "Alpha", attention: "input_required" }),
          chatRecord({ id: "b", title: "Beta" }),
          chatRecord({ id: "c", title: "Gamma", attention: "failed" }),
        ],
      });

      const group = screen.getByTestId("side-panel-needs-you-group");
      expect(within(screen.getByTestId("side-panel-needs-you")).getByText("2")).toBeTruthy();
      expect(screen.getByLabelText("2 chats")).toBeTruthy();
      expect(within(group).getAllByRole("button").map((row) => row.props.testID)).toEqual([
        "side-panel-chat-a", "side-panel-chat-c",
      ]);
      expect(within(group).queryByTestId("side-panel-chat-b")).toBeNull();
      expect(screen.getByTestId("side-panel-chat-b")).toBeTruthy();
    });

    it("sets the count 6pt beside the label, and the group's rows 4pt apart", () => {
      renderPanel();

      expect(flat(screen.getByTestId("side-panel-needs-you"))).toMatchObject({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
      });
      expect(flat(screen.getByTestId("side-panel-needs-you-group")).gap).toBe(4);
      expect(flat(screen.getByTestId("side-panel-blocks")).marginBottom).toBe(4);
      expect(flat(screen.getAllByTestId("side-panel-row-gap")[0]).height).toBe(4);
    });

    it("hides Needs you when no chat needs the person", () => {
      renderPanel({ chats: C2_CHATS.slice(1) });

      expect(screen.queryByText("Needs you")).toBeNull();
      expect(screen.queryByTestId("side-panel-needs-you")).toBeNull();
      expect(screen.getByText("Recent")).toBeTruthy();
    });

    it("hides Recent when every chat needs the person", () => {
      renderPanel({ chats: C2_CHATS.slice(0, 1) });

      expect(screen.getByText("Needs you")).toBeTruthy();
      expect(screen.queryByText("Recent")).toBeNull();
    });
  });
});
