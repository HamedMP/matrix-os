import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import * as Clipboard from "expo-clipboard";
import { MermaidDiagram } from "../components/chat/MermaidDiagram";
import { mermaidDocument } from "../components/chat/mermaid-document";
import type { ChatMarkdownTheme } from "../lib/chat-markdown";
jest.mock("../components/chat/mermaid-bundle", () => ({ MERMAID_JS: "/* offline test renderer */" }));
jest.mock("react-native-webview", () => {
  const { View } = jest.requireActual("react-native");
  return { __esModule: true, default: (props: object) => <View testID="diagram-webview" {...props} /> };
});
const theme: ChatMarkdownTheme = { textStyle: {}, mutedColor: "#666", linkColor: "#00f", codeBackground: "#eee", codeBorderColor: "#ccc", monoFontFamily: "mono", boldFontFamily: "bold", headingFontFamily: "heading" };

it("embeds an offline, network-blocked document and cannot break its script boundary", () => {
  const html = mermaidDocument('flowchart LR\nA["</script><script>bad()</script>"]');
  expect(html).toContain("default-src 'none'");
  expect(html).toContain('"securityLevel":"strict"');
  expect(html).not.toContain('<script>bad()');
  expect(html).toContain("\\u003c/script>");
  expect(mermaidDocument("x".repeat(30_001))).toBeNull();
});

it("blocks navigation, bounds bridge messages and preserves source/copy after failure", async () => {
  const source = "flowchart LR\nA-->B";
  render(<MermaidDiagram source={source} theme={theme} />);
  const frame = screen.getByTestId("diagram-webview");
  expect(frame.props.onShouldStartLoadWithRequest({ url: "https://example.com" })).toBe(false);
  expect(frame.props.onShouldStartLoadWithRequest({ url: "about:blank" })).toBe(true);
  expect(frame.props.allowFileAccess).toBe(false);
  act(() => frame.props.onMessage({ nativeEvent: { data: '{"height":100000000}' } }));
  expect(screen.getByTestId("diagram-webview").props.style.height).toBe(1000);
  expect(screen.getByTestId("diagram-webview").props.scrollEnabled).toBe(true);
  expect(screen.getByTestId("diagram-webview").props.nestedScrollEnabled).toBe(true);
  act(() => frame.props.onMessage({ nativeEvent: { data: '{"error":true}' } }));
  expect(screen.queryByTestId("diagram-webview")).toBeNull();
  expect(screen.getByText(source)).toBeTruthy();
  await act(async () => fireEvent.press(screen.getByLabelText("Copy diagram source")));
  expect(Clipboard.setStringAsync).toHaveBeenCalledWith(source);
});
it("falls back to readable source when the embedded renderer never finishes", () => {
  jest.useFakeTimers();
  try {
    render(<MermaidDiagram source="flowchart LR; A-->B" theme={theme} />);
    act(() => jest.advanceTimersByTime(15_000));
    expect(screen.queryByTestId("diagram-webview")).toBeNull();
    expect(screen.getByText("Diagram unavailable. View the source below.")).toBeTruthy();
  } finally { jest.useRealTimers(); }
});
