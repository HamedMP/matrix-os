import React from "react";
import { View } from "react-native";
import { render, screen } from "@testing-library/react-native";
import { renderChatMarkdown, type ChatMarkdownTheme } from "../lib/chat-markdown";
const theme: ChatMarkdownTheme = { textStyle: {}, mutedColor: "#666", linkColor: "#00f", codeBackground: "#eee", codeBorderColor: "#ccc", monoFontFamily: "mono", boldFontFamily: "bold", headingFontFamily: "heading" };
it("renders completed Mermaid fences as diagrams and leaves unfinished streaming fences as source", () => {
  const diagram = jest.fn((source: string, key: string) => <View key={key} testID="diagram" accessibilityLabel={source} />);
  const source = "flowchart LR\nA-->B";
  const { rerender } = render(<View>{renderChatMarkdown(`\`\`\`mermaid\n${source}`, theme, [], diagram)}</View>);
  expect(diagram).not.toHaveBeenCalled();
  rerender(<View>{renderChatMarkdown(`\`\`\`mermaid\n${source}\n\`\`\``, theme, [], diagram)}</View>);
  expect(diagram).toHaveBeenCalledWith(source, expect.any(String));
  expect(screen.getByTestId("diagram").props.accessibilityLabel).toBe(source);
});
it("keeps other languages as code", () => {
  const diagram = jest.fn();
  render(<View>{renderChatMarkdown("```ts\nconst value = 1;\n```", theme, [], diagram)}</View>);
  expect(diagram).not.toHaveBeenCalled();
  expect(screen.getByText("const value = 1;")).toBeTruthy();
});
it("bounds the number of live diagrams within one long message", () => {
  const diagram = jest.fn((_source: string, key: string) => <View key={key} />);
  const text = Array(20).fill("```mermaid\nflowchart LR; A-->B\n```").join("\n");
  render(<View>{renderChatMarkdown(text, theme, [], diagram)}</View>);
  expect(diagram).toHaveBeenCalledTimes(10);
});
