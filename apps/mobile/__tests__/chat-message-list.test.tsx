import { act, cleanup, fireEvent, render, screen } from "@testing-library/react-native";
import { Alert, FlatList, StyleSheet as NativeStyleSheet, Text, View } from "react-native";

import { MessageList } from "../components/chat/MessageList";
import { AnalyticsMask } from "../lib/analytics";
import type { TranscriptMessage } from "../lib/canonical-chat-transcript";

import { drawnTestIds } from "./chat-test-utils";
import { flat } from "./ui-test-utils";

jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));

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

    expect(drawnTestIds(screen.getByTestId("assistant-message"))).toEqual([
      "assistant-text",
      "steps-block",
      "results-msg_reply",
    ]);
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

  it("offers the chat menu on a long press, and nothing for a chat that does not exist yet", () => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    const view = render(<MessageList messages={[question]} chatId="chat_1" />);

    fireEvent(screen.getByText("Build an app that tracks my habits"), "longPress");
    expect(alert.mock.calls[0]?.[2]?.some((button) => button.text === "Copy chat ID")).toBe(true);

    alert.mockClear();
    view.rerender(<MessageList messages={[question]} chatId={null} />);
    fireEvent(screen.getByText("Build an app that tracks my habits"), "longPress");
    expect(alert).not.toHaveBeenCalled();
  });
});
