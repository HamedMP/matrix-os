import { cleanup, fireEvent, render, screen, within } from "@testing-library/react-native";
import { KeyboardAvoidingView, Text } from "react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";

import { Composer } from "../components/chat/Composer";
import { ProjectScreen, type ProjectScreenProps } from "../components/projects/ProjectScreen";
import type { ProjectChatRow } from "../components/projects/project-rows";
import { EmptyState } from "../components/ui/EmptyState";
import { Icon } from "../components/ui/Icon";
import { IconTile } from "../components/ui/IconTile";
import { BackIcon, ChatIcon, FolderIcon, MoreIcon } from "../components/ui/icons";

import { flat } from "./ui-test-utils";

let mockKeyboardVisible = false;
jest.mock("@/lib/use-keyboard-visible", () => ({ useKeyboardVisible: () => mockKeyboardVisible }));

// The reanimated mock in jest.setup.js has no `cancelAnimation`, which the
// skeleton rows call when they unmount.
const reanimated = jest.requireMock<{ cancelAnimation?: unknown }>("react-native-reanimated");
reanimated.cancelAnimation ??= jest.fn();

const rows: ProjectChatRow[] = [
  { id: "chat_case", title: "Case study", preview: "Draft ready to review", time: "2h" },
  { id: "chat_landing", title: "Landing page copy", preview: "Three headline options", time: "Yesterday" },
  { id: "chat_bare", title: "New chat" },
];

type Overrides = Partial<Omit<ProjectScreenProps, "chats" | "composer">> & {
  chats?: Partial<ProjectScreenProps["chats"]>;
  composer?: Partial<ProjectScreenProps["composer"]>;
};

function renderScreen({ chats, composer, ...overrides }: Overrides = {}) {
  const props: ProjectScreenProps = {
    state: "ready",
    project: { id: "proj_portfolio", name: "Portfolio", updated: "Updated today" },
    chats: {
      state: "ready",
      rows,
      hasMore: false,
      loadingMore: false,
      loadMoreFailed: false,
      refreshing: false,
      onRefresh: jest.fn(),
      onRetry: jest.fn(),
      onLoadMore: jest.fn(),
      onOpenChat: jest.fn(),
      ...chats,
    },
    composer: { draft: "", onChangeDraft: jest.fn(), canSend: false, onSend: jest.fn(), ...composer },
    onBack: jest.fn(),
    onOpenOptions: jest.fn(),
    onRetry: jest.fn(),
    ...overrides,
  };
  render(
    <SafeAreaInsetsContext.Provider value={{ top: 62, right: 0, bottom: 34, left: 0 }}>
      <ProjectScreen {...props} />
    </SafeAreaInsetsContext.Provider>,
  );
  return props;
}

const list = () => screen.getByTestId("project-chats");
const listContent = () => flat({ props: { style: list().props.contentContainerStyle } });

describe("project screen", () => {
  afterEach(() => {
    cleanup();
    mockKeyboardVisible = false;
  });

  it("starts below the status bar on the background colour and makes room for the keyboard", () => {
    renderScreen();

    const frame = screen.getByTestId("project-screen");
    expect(flat(frame)).toMatchObject({ flex: 1, paddingTop: 62, backgroundColor: "#FFFEFC" });
    expect(screen.UNSAFE_getByType(KeyboardAvoidingView).props.behavior).toBe("padding");
  });

  it("tops the screen with back, the project's name centred, and the options button", () => {
    const props = renderScreen();

    const bar = screen.getByTestId("project-top-bar");
    expect(flat(within(bar).getByRole("header", { name: "Portfolio" }))).toMatchObject({
      fontFamily: "Geist_600SemiBold",
      fontSize: 16,
      lineHeight: 22,
      textAlign: "center",
    });
    const back = within(screen.getByTestId("project-top-bar-leading")).getByRole("button", { name: "Back" });
    expect(flat(back)).toMatchObject({ width: 44, height: 44 });
    expect(within(back).UNSAFE_getByType(Icon).props).toMatchObject({ icon: BackIcon, size: 22 });
    const options = within(screen.getByTestId("project-top-bar-trailing")).getByRole("button", { name: "Project options" });
    expect(flat(options)).toMatchObject({ width: 44, height: 44 });
    expect(within(options).UNSAFE_getByType(Icon).props.icon).toBe(MoreIcon);

    fireEvent.press(back);
    fireEvent.press(options);
    expect(props.onBack).toHaveBeenCalledTimes(1);
    expect(props.onOpenOptions).toHaveBeenCalledTimes(1);
  });

  it("heads the chats 12pt under the bar with a 52pt folder tile 14pt from the name and when it last changed", () => {
    renderScreen();

    expect(flat(screen.getByTestId("project-intro"))).toMatchObject({ paddingTop: 12, gap: 18, paddingBottom: 18 });
    const header = screen.getByTestId("project-header");
    expect(flat(header)).toMatchObject({ flexDirection: "row", alignItems: "center", gap: 14 });
    expect(within(header).UNSAFE_getByType(IconTile).props).toMatchObject({ icon: FolderIcon, size: 52 });
    expect(flat(within(header).getByText("Portfolio"))).toMatchObject({
      fontFamily: "Geist_600SemiBold",
      fontSize: 24,
      lineHeight: 34,
      color: "#242323",
    });
    expect(flat(within(header).getByText("Updated today"))).toMatchObject({
      fontFamily: "Geist_400Regular",
      fontSize: 13,
      lineHeight: 18,
      color: "#635F5F",
      marginTop: 2,
    });
  });

  it("leaves the time out of the header when it is not known", () => {
    renderScreen({ project: { id: "proj_notes", name: "Field notes" } });

    const texts = within(screen.getByTestId("project-header")).getAllByText(/./);
    expect(texts.map((node) => node.props.children)).toEqual(["Field notes"]);
  });

  it("labels the chats, 18pt under the header and 18pt above the first row", () => {
    renderScreen();

    const intro = screen.getByTestId("project-intro");
    const label = within(intro).getByRole("header", { name: "Chats" });
    expect(flat(label)).toMatchObject({ fontSize: 12, lineHeight: 17, textTransform: "uppercase", color: "#8A8686" });
    expect(intro.children).toHaveLength(2);
  });

  it("lists the chats 20pt in with no space between their rows", () => {
    renderScreen();

    expect(listContent()).toMatchObject({ flexGrow: 1, paddingHorizontal: 20, paddingBottom: 20 });
    expect(listContent().gap).toBeUndefined();
    expect(list().props.ItemSeparatorComponent).toBeUndefined();
    expect(screen.getAllByTestId(/^project-chat-[a-z_]+$/)).toHaveLength(3);
  });

  it("draws a chat as a compact row: a 40pt round chat tile, its title over its last message, and its time", () => {
    renderScreen();

    const row = screen.getByTestId("project-chat-chat_case");
    expect(flat(row)).toMatchObject({ flexDirection: "row", alignItems: "center", paddingVertical: 10 });
    expect(within(row).UNSAFE_getByType(IconTile).props).toMatchObject({
      icon: ChatIcon,
      size: 40,
      shape: "circle",
      tone: "subtle",
    });
    expect(flat(screen.getByTestId("project-chat-chat_case-leading")).marginRight).toBe(12);
    expect(within(row).getAllByText(/./).map((node) => node.props.children)).toEqual([
      "Case study",
      "Draft ready to review",
      "2h",
    ]);
    expect(flat(within(row).getByText("2h"))).toMatchObject({ fontSize: 12, lineHeight: 17, color: "#8A8686" });
  });

  it("shows only the title of a chat with no last message and no time", () => {
    renderScreen();

    const row = screen.getByTestId("project-chat-chat_bare");
    expect(within(row).getAllByText(/./).map((node) => node.props.children)).toEqual(["New chat"]);
    expect(row.props.accessibilityLabel).toBe("New chat");
  });

  it("opens the chat whose row is pressed, and names the row once for a screen reader", () => {
    const { chats } = renderScreen();

    const row = screen.getByTestId("project-chat-chat_landing");
    expect(row.props.accessibilityRole).toBe("button");
    expect(row.props.accessibilityLabel).toBe("Landing page copy, Three headline options, Yesterday");
    fireEvent.press(row);

    expect(chats.onOpenChat).toHaveBeenCalledWith("chat_landing");
  });

  it("loads more chats as the list nears its end while the server has more", () => {
    const { chats } = renderScreen({ chats: { hasMore: true } });

    expect(list().props.onEndReachedThreshold).toBe(0.5);
    fireEvent(list(), "endReached");

    expect(chats.onLoadMore).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["there are no more", { hasMore: false }],
    ["a page is already on its way", { hasMore: true, loadingMore: true }],
    ["the last page failed", { hasMore: true, loadMoreFailed: true }],
  ])("does not load more at the end of the list when %s", (_case, state) => {
    const { chats } = renderScreen({ chats: state });

    fireEvent(list(), "endReached");

    expect(chats.onLoadMore).not.toHaveBeenCalled();
  });

  it("offers Load more under the rows while the server has more", () => {
    const { chats } = renderScreen({ chats: { hasMore: true } });

    fireEvent.press(screen.getByRole("button", { name: "Load more chats" }));

    expect(chats.onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("keeps Load more in reach when a page came back empty but the server has more", () => {
    const { chats } = renderScreen({ chats: { rows: [], hasMore: true } });

    expect(screen.queryByText("No chats in this project yet")).toBeNull();
    fireEvent.press(screen.getByRole("button", { name: "Load more chats" }));

    expect(chats.onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("shows skeleton rows under the chats while a further page loads", () => {
    renderScreen({ chats: { hasMore: true, loadingMore: true } });

    expect(screen.getByTestId("recent-chat-skeleton")).toBeTruthy();
    expect(screen.getByTestId("project-chat-chat_case")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more chats" })).toBeNull();
  });

  it("says a further page could not be loaded, with a retry, and keeps the chats it has", () => {
    const { chats } = renderScreen({ chats: { hasMore: true, loadMoreFailed: true } });

    expect(screen.getByRole("alert").props.children).toBe("Older chats could not be loaded.");
    expect(screen.getByTestId("project-chat-chat_case")).toBeTruthy();
    fireEvent.press(screen.getByRole("button", { name: "Try again" }));

    expect(chats.onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("shows skeleton rows under the header while the chats load", () => {
    renderScreen({ chats: { state: "loading", rows: [] } });

    expect(screen.getByTestId("recent-chat-skeleton")).toBeTruthy();
    expect(screen.getByTestId("project-header")).toBeTruthy();
    expect(screen.queryByTestId(/^project-chat-chat_/)).toBeNull();
    expect(screen.queryByText("No chats in this project yet")).toBeNull();
  });

  it("says in generic words, with a retry, that the chats could not be loaded", () => {
    const { chats } = renderScreen({ chats: { state: "error", rows: [] } });

    const line = screen.getByRole("alert");
    expect(line.props.children).toBe("Chats could not be loaded.");
    expect(flat(line)).toMatchObject({ fontSize: 14, lineHeight: 20, color: "#635F5F", textAlign: "center" });
    fireEvent.press(screen.getByRole("button", { name: "Try again" }));

    expect(chats.onRetry).toHaveBeenCalledTimes(1);
    expect(chats.onLoadMore).not.toHaveBeenCalled();
  });

  it("says the project has no chats yet with the existing empty state", () => {
    renderScreen({ chats: { rows: [] } });

    expect(screen.UNSAFE_getByType(EmptyState).props).toMatchObject({
      icon: ChatIcon,
      message: "No chats in this project yet",
    });
  });

  it("reads the project again when the list is pulled down", () => {
    const { chats } = renderScreen({ chats: { refreshing: true } });

    expect(list().props.refreshing).toBe(true);
    fireEvent(list(), "refresh");

    expect(chats.onRefresh).toHaveBeenCalledTimes(1);
  });

  it("ends with the chat screen's composer, asking for a new chat in the project", () => {
    const onChangeDraft = jest.fn();
    const onSend = jest.fn();
    renderScreen({
      composer: { draft: "Draft the case study", onChangeDraft, canSend: true, onSend, modelControl: <Text>Matrix AI · Sonnet 5</Text> },
    });

    const input = screen.getByLabelText("Message Matrix");
    expect(input.props).toMatchObject({ placeholder: "New chat in Portfolio", value: "Draft the case study" });
    expect(within(screen.getByTestId("composer-toolbar-leading")).getByText("Matrix AI · Sonnet 5")).toBeTruthy();
    const last = screen.getByTestId("project-screen").children.at(-1);
    expect(typeof last === "string" ? last : last?.type).toBe(Composer);

    fireEvent.changeText(input, "Draft the case study now");
    fireEvent.press(screen.getByRole("button", { name: "Send message" }));
    expect(onChangeDraft).toHaveBeenCalledWith("Draft the case study now");
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("rests the composer on the keyboard while it is open", () => {
    renderScreen();
    expect(flat(screen.getByTestId("composer")).paddingBottom).toBe(10);
    cleanup();

    mockKeyboardVisible = true;
    renderScreen();
    expect(flat(screen.getByTestId("composer")).paddingBottom).toBe(8);
  });

  it("keeps the keyboard out of the way of the rows", () => {
    renderScreen();

    expect(list().props).toMatchObject({ keyboardShouldPersistTaps: "handled", keyboardDismissMode: "on-drag" });
  });

  it("shows no chat count, no instructions and nothing to delete", () => {
    renderScreen();

    expect(screen.queryByText(/\d+ chats?/i)).toBeNull();
    expect(screen.queryByText(/instructions/i)).toBeNull();
    expect(screen.queryByText(/delete/i)).toBeNull();
  });

  describe("without a project to show", () => {
    function expectBareScreen(props: ProjectScreenProps) {
      expect(screen.queryByRole("button", { name: "Project options" })).toBeNull();
      expect(screen.queryByTestId("composer")).toBeNull();
      expect(screen.queryByTestId("project-chats")).toBeNull();
      fireEvent.press(screen.getByRole("button", { name: "Back" }));
      expect(props.onBack).toHaveBeenCalledTimes(1);
    }

    it("shows the existing skeleton rows, 20pt in, while the projects load", () => {
      const props = renderScreen({ state: "loading", project: null });

      expect(screen.getAllByTestId("project-skeleton-row").length).toBeGreaterThan(0);
      expect(flat(screen.getByTestId("project-loading")).paddingHorizontal).toBe(20);
      expectBareScreen(props);
    });

    it("says in generic words, with a retry, that the project could not be loaded", () => {
      const props = renderScreen({ state: "error", project: null });

      expect(screen.getByRole("alert").props.children).toBe("Project could not be loaded.");
      fireEvent.press(screen.getByRole("button", { name: "Try again" }));
      expect(props.onRetry).toHaveBeenCalledTimes(1);
      expectBareScreen(props);
    });

    it("says the project was not found, with the way back in the top bar", () => {
      const props = renderScreen({ state: "missing", project: null });

      expect(screen.UNSAFE_getByType(EmptyState).props).toMatchObject({ icon: FolderIcon, message: "Project not found" });
      expect(screen.queryByRole("alert")).toBeNull();
      expectBareScreen(props);
    });
  });
});
