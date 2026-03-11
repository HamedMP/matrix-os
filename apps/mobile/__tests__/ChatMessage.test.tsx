import React from "react";
import { render, screen } from "@testing-library/react-native";
import { ChatMessage } from "../components/ChatMessage";
import type { Message } from "../app/(tabs)/chat";

function msg(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    role: "user",
    content: "Hello world",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("ChatMessage", () => {
  it("renders user message text", () => {
    render(<ChatMessage message={msg()} />);
    expect(screen.getByText("Hello world")).toBeTruthy();
  });

  it("renders assistant message text", () => {
    render(
      <ChatMessage message={msg({ role: "assistant", content: "Hi there" })} />,
    );
    expect(screen.getByText("Hi there")).toBeTruthy();
  });

  it("renders system message text", () => {
    render(
      <ChatMessage message={msg({ role: "system", content: "Error occurred" })} />,
    );
    expect(screen.getByText("Error occurred")).toBeTruthy();
  });

  it("renders tool message with tool label", () => {
    render(
      <ChatMessage
        message={msg({ role: "tool", content: "Using read_file", tool: "read_file" })}
      />,
    );
    expect(screen.getByText("read_file")).toBeTruthy();
    expect(screen.getByText("Using read_file")).toBeTruthy();
  });

  it("renders code blocks when content contains triple backticks", () => {
    const content = "Here is code:\n```typescript\nconst x = 1;\n```";
    render(<ChatMessage message={msg({ role: "assistant", content })} />);
    expect(screen.getByText("const x = 1;")).toBeTruthy();
    expect(screen.getByText("typescript")).toBeTruthy();
  });

  it("renders code block copy button", () => {
    const content = "```js\nlet a = 1;\n```";
    render(<ChatMessage message={msg({ role: "assistant", content })} />);
    expect(screen.getByText("Copy")).toBeTruthy();
  });

  it("renders plain text without code wrapper when no backticks", () => {
    render(
      <ChatMessage message={msg({ role: "assistant", content: "Just plain text" })} />,
    );
    expect(screen.getByText("Just plain text")).toBeTruthy();
  });

  it("extracts inline images from markdown syntax", () => {
    const content = "Look: ![screenshot](/files/img.png)";
    render(
      <ChatMessage
        message={msg({ role: "assistant", content })}
        gatewayUrl="http://localhost:4000"
      />,
    );
    const images = screen.queryAllByLabelText("screenshot");
    expect(images.length).toBe(1);
  });

  it("extracts file attachments from markdown links", () => {
    const content = "Download: [report.pdf](/files/report.pdf)";
    render(
      <ChatMessage
        message={msg({ role: "assistant", content })}
        gatewayUrl="http://localhost:4000"
      />,
    );
    expect(screen.getAllByText("report.pdf").length).toBeGreaterThanOrEqual(1);
  });

  it("does not show image for non-image file links", () => {
    const content = "[data.csv](/files/data.csv)";
    render(
      <ChatMessage
        message={msg({ role: "assistant", content })}
        gatewayUrl="http://localhost:4000"
      />,
    );
    expect(screen.getAllByText("data.csv").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryAllByLabelText("Image")).toHaveLength(0);
  });
});
