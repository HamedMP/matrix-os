import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import { FlatList, StyleSheet as NativeStyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { contentShape, shapes } from "@expo/ui/swift-ui/modifiers";

import * as mockContextMenu from "./context-menu-test-utils";
import { MessageList } from "../components/chat/MessageList";
import { AnalyticsMask } from "../lib/analytics";
import type { TranscriptMessage } from "../lib/canonical-chat-transcript";

import { drawnTestIds } from "./chat-test-utils";
import { CONTEXT_MENU_TEST_IDS, menuAround, menuItem, menuItemLabels } from "./context-menu-test-utils";
import { flat } from "./ui-test-utils";

jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));
// Jest resolves the iOS files, so each message sits in a native context menu.
jest.mock("@expo/ui/swift-ui", () => mockContextMenu.swiftUiContextMenuModule());

function message(overrides: Partial<TranscriptMessage> & Pick<TranscriptMessage, "id" | "role" | "text">): TranscriptMessage {
  return { toolCalls: [], activities: [], isRunning: false, createdAt: 0, ...overrides };
}

const question = message({ id: "msg_user", role: "user", text: "Build an app that tracks my habits" });
const reply = message({
  id: "msg_reply", role: "assistant", text: "Done. It has a daily checklist.", elapsedSeconds: 12,
  activities: [{ id: "step_1", kind: "tool", state: "completed", label: "Created the app" }],
});

describe("MessageList", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    act(() => jest.runOnlyPendingTimers());
    cleanup();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("draws the messages from the bottom up, 20pt from the sides and 14pt apart", () => {
    render(<MessageList messages={[reply, question]} chatId="chat_1" />);

    const list = screen.UNSAFE_getByType(FlatList);
    expect(list.props.inverted).toBe(true);
    expect(list.props.data).toEqual([reply, question]);
    const content = NativeStyleSheet.flatten(list.props.contentContainerStyle) as Record<string, unknown>;
    expect(content).toMatchObject({ paddingHorizontal: 20, paddingVertical: 20, gap: 14 });
    // A short chat rests on the composer, as drawn, rather than under the top bar.
    expect(content.justifyContent).toBeUndefined();
  });

  it("draws a footer after the newest message, which an inverted list takes as its header", () => {
    const view = render(
      <MessageList messages={[reply, question]} chatId="chat_1" footer={<Text>Needs your approval</Text>} />,
    );

    const list = screen.UNSAFE_getByType(FlatList);
    expect(list.props.ListHeaderComponent).toBeTruthy();
    expect(list.props.ListFooterComponent).toBeUndefined();
    // Like the messages, it stays out of session replay.
    const masks = screen.UNSAFE_getAllByType(AnalyticsMask);
    expect(masks).toHaveLength(3);
    expect(masks.filter((mask) => within(mask).queryByText("Needs your approval"))).toHaveLength(1);

    view.rerender(<MessageList messages={[reply, question]} chatId="chat_1" />);
    expect(screen.queryByText("Needs your approval")).toBeNull();
    expect(screen.UNSAFE_getByType(FlatList).props.ListHeaderComponent).toBeNull();
    expect(screen.UNSAFE_getAllByType(AnalyticsMask)).toHaveLength(2);
  });

  it("closes the keyboard on a tap in an existing chat, and lets taps through in one that is not created yet", () => {
    const view = render(<MessageList messages={[question]} chatId="chat_1" />);
    expect(screen.UNSAFE_getByType(FlatList).props.keyboardShouldPersistTaps).toBe("never");

    view.rerender(<MessageList messages={[question]} chatId={null} />);
    expect(screen.UNSAFE_getByType(FlatList).props.keyboardShouldPersistTaps).toBe("handled");
  });

  it("puts a user message in a right-aligned bubble at most 80% wide", () => {
    render(<MessageList messages={[question]} chatId="chat_1" />);

    expect(flat(screen.getByTestId("user-message"))).toMatchObject({
      alignSelf: "flex-end",
      maxWidth: "80%",
      backgroundColor: "#FAF9F7",
      borderRadius: 18,
      paddingHorizontal: 14,
      paddingVertical: 10,
    });
    expect(flat(screen.getByText("Build an app that tracks my habits"))).toMatchObject({
      fontFamily: "Geist_400Regular",
      fontSize: 15,
      lineHeight: 22,
      color: "#242323",
    });
  });

  it("writes a reply across the full width in the 15pt text style", () => {
    render(<MessageList messages={[reply]} chatId="chat_1" />);

    expect(flat(screen.getByTestId("assistant-message"))).toMatchObject({ alignSelf: "stretch", gap: 14 });
    const [text] = screen.getAllByText("Done. It has a daily checklist.");
    expect(flat(text)).toMatchObject({
      fontFamily: "Geist_400Regular",
      fontSize: 15,
      lineHeight: 22,
      color: "#242323",
    });
  });

  it("orders a reply as its text, then its steps, then what belongs under it", () => {
    render(
      <MessageList
        messages={[reply]}
        chatId="chat_1"
        renderResults={(item) => <View testID={`results-${item.id}`} />}
      />,
    );

    const drawn = drawnTestIds(screen.getByTestId("assistant-message"))
      .filter((id) => !CONTEXT_MENU_TEST_IDS.includes(id));
    expect(drawn).toEqual(["assistant-text", "steps-block", "results-msg_reply"]);
  });

  it("asks for results under replies only", () => {
    const renderResults = jest.fn((_message: TranscriptMessage) => null);
    render(<MessageList messages={[reply, question]} chatId="chat_1" renderResults={renderResults} />);

    expect(renderResults.mock.calls.map(([item]) => item.id)).toEqual(["msg_reply"]);
  });

  it("draws no text block for a reply that has no text yet", () => {
    render(<MessageList messages={[message({ id: "msg_working", role: "assistant", text: "", isRunning: true })]} chatId="chat_1" />);

    expect(screen.queryByTestId("assistant-text")).toBeNull();
    expect(screen.getByText("Working…")).toBeTruthy();
  });

  it("writes system and tool messages in the subtle 13pt style, system ones centred", () => {
    render(
      <MessageList
        messages={[
          message({ id: "msg_system", role: "system", text: "Run stopped" }),
          message({ id: "msg_tool", role: "tool", text: "Tool output" }),
        ]}
        chatId="chat_1"
      />,
    );

    expect(flat(screen.getByText("Run stopped"))).toMatchObject({
      fontFamily: "Geist_400Regular", fontSize: 13, lineHeight: 18, color: "#635F5F", textAlign: "center",
    });
    expect(flat(screen.getByText("Tool output"))).toMatchObject({ fontSize: 13, color: "#635F5F" });
    expect(flat(screen.getByText("Tool output")).textAlign).toBeUndefined();
  });

  it("lets the screen draw a message that asks the person something", () => {
    const request = message({ id: "msg_request", role: "system", text: "Allow this?" });
    render(
      <MessageList
        messages={[request, question]}
        chatId="chat_1"
        renderRequest={(item) => (item.id === "msg_request" ? <Text>Approval card</Text> : null)}
      />,
    );

    expect(screen.getByText("Approval card")).toBeTruthy();
    expect(screen.queryByText("Allow this?")).toBeNull();
    expect(screen.getByText("Build an app that tracks my habits")).toBeTruthy();
  });

  it("keeps every message out of session replay", () => {
    render(<MessageList messages={[reply, question]} chatId="chat_1" />);

    expect(screen.UNSAFE_getAllByType(AnalyticsMask)).toHaveLength(2);
  });

  it("offers a message's text and the chat in the long-press menu", () => {
    render(<MessageList messages={[reply, question]} chatId="chat_1" />);

    expect(menuItemLabels(menuAround(screen.getByText("Build an app that tracks my habits")))).toEqual([
      "Copy text", "Share", "Copy chat ID",
    ]);
    const [replyText] = screen.getAllByText("Done. It has a daily checklist.");
    expect(menuItemLabels(menuAround(replyText!))).toEqual(["Copy text", "Share", "Copy chat ID"]);
    expect(screen.getAllByTestId("context-menu-share").map((share) => share.props.accessibilityValue.text)).toEqual([
      "Done. It has a daily checklist.",
      "Build an app that tracks my habits",
    ]);
  });

  it("offers a message's text but no chat ID in a chat that does not exist yet", () => {
    render(<MessageList messages={[question]} chatId={null} />);

    expect(menuItemLabels(menuAround(screen.getByText("Build an app that tracks my habits")))).toEqual(["Copy text", "Share"]);
  });

  it("offers a reply's text only once it has finished", () => {
    const working = message({ id: "msg_working", role: "assistant", text: "Adding the weekly", isRunning: true });
    const view = render(<MessageList messages={[working]} chatId="chat_1" />);

    expect(menuItemLabels(menuAround(screen.getByTestId("assistant-text")))).toEqual(["Copy chat ID"]);

    view.rerender(<MessageList messages={[{ ...working, text: "Added the weekly view.", isRunning: false }]} chatId="chat_1" />);
    expect(menuItemLabels(menuAround(screen.getByTestId("assistant-text")))).toEqual([
      "Copy text", "Share", "Copy chat ID",
    ]);
  });

  it("lifts a question's bubble alone, at its own size against the end and with its own corners", () => {
    render(<MessageList messages={[question]} chatId="chat_1" />);

    const menu = menuAround(screen.getByTestId("user-message"));
    // The row the menu measures and aligns its content in.
    let row = menu.parent;
    while (row && typeof row.props.onLayout !== "function") row = row.parent;
    expect(NativeStyleSheet.flatten(row!.props.style)).toMatchObject({ alignSelf: "stretch", alignItems: "flex-end" });
    expect(within(menu).getByTestId("context-menu-preview").props.previewModifiers).toEqual([
      contentShape(shapes.roundedRectangle({ cornerRadius: 18 }), "contextMenuPreview"),
    ]);
  });

  it("lifts a reply's text alone, not its steps and results", () => {
    render(
      <MessageList
        messages={[reply]}
        chatId="chat_1"
        renderResults={(item) => <View testID={`results-${item.id}`} />}
      />,
    );

    const menu = menuAround(screen.getByTestId("assistant-text"));
    expect(within(menu).queryByTestId("steps-block")).toBeNull();
    expect(within(menu).queryByTestId("results-msg_reply")).toBeNull();
    expect(within(menu).getByTestId("context-menu-preview").props.previewModifiers).toEqual([
      contentShape(shapes.roundedRectangle({ cornerRadius: 12 }), "contextMenuPreview"),
    ]);
    // On a card of the screen's colour, so the lift's shadow stays around the text, not over it.
    const hosted = within(menu).getByTestId("context-menu-preview").findByType(View);
    expect(NativeStyleSheet.flatten(hosted.props.style)).toMatchObject({ padding: 10, backgroundColor: "#FFFEFC" });
  });

  it("lifts a question's bubble on its own colour, with no extra fill", () => {
    render(<MessageList messages={[question]} chatId="chat_1" />);

    const hosted = within(menuAround(screen.getByTestId("user-message"))).getByTestId("context-menu-preview").findByType(View);
    expect(NativeStyleSheet.flatten(hosted.props.style)?.backgroundColor).toBeUndefined();
  });

  it("puts no menu on a message the screen draws as a request", () => {
    const request = message({ id: "msg_request", role: "system", text: "Allow this?" });
    render(
      <MessageList
        messages={[request]}
        chatId="chat_1"
        renderRequest={(item) => (item.id === "msg_request" ? <Text>Approval card</Text> : null)}
      />,
    );

    expect(screen.getByText("Approval card")).toBeTruthy();
    expect(screen.queryByTestId("context-menu")).toBeNull();
  });

  it("copies a message's text from its menu", async () => {
    render(<MessageList messages={[question]} chatId="chat_1" />);

    fireEvent.press(menuItem(screen.getByText("Build an app that tracks my habits"), "Copy text"));

    await waitFor(() => expect(Clipboard.setStringAsync).toHaveBeenCalledWith("Build an app that tracks my habits"));
  });
});
