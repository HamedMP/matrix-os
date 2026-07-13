jest.mock("expo-image", () => {
  const { View } = require("react-native");
  return {
    Image: (props: Record<string, unknown>) => {
      const mockReact = require("react");
      return mockReact.createElement(View, { testID: "expo-image", ...props });
    },
  };
});

import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react-native";
import { ChatMessage } from "../components/ChatMessage";
import type { Message } from "../app/(tabs)/chat";
import type { GatewayClient } from "../lib/gateway-client";

function imageClient(overrides: Partial<Record<"homeFileUrl" | "getAuthorizationHeader", unknown>> = {}) {
  return {
    homeFileUrl: jest.fn((rel: string) => `http://gw.test/files/${rel}`),
    getAuthorizationHeader: jest.fn().mockResolvedValue("Bearer test-token"),
    ...overrides,
  };
}

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

  it("loads inline images through the authenticated owner file URL", async () => {
    const client = imageClient();
    const content = "Look: ![screenshot](/files/system/shot.png)";
    render(
      <ChatMessage
        message={msg({ role: "assistant", content })}
        client={client as unknown as GatewayClient}
      />,
    );

    const image = await screen.findByLabelText("screenshot");
    expect(client.getAuthorizationHeader).toHaveBeenCalled();
    expect(client.homeFileUrl).toHaveBeenCalledWith("system/shot.png");
    expect(image.props.source.uri).toBe("http://gw.test/files/system/shot.png");
    expect(image.props.source.headers).toEqual({ Authorization: "Bearer test-token" });
  });

  it("does not render inline images when the auth header fails to resolve", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const client = imageClient({
      getAuthorizationHeader: jest.fn().mockRejectedValue(new Error("no session")),
    });
    const content = "Look: ![screenshot](/files/system/shot.png)";
    render(
      <ChatMessage
        message={msg({ role: "assistant", content })}
        client={client as unknown as GatewayClient}
      />,
    );

    await waitFor(() => expect(client.getAuthorizationHeader).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryAllByLabelText("screenshot")).toHaveLength(0);
    warn.mockRestore();
  });

  it("does not render inline images when the auth header is empty", async () => {
    const client = imageClient({
      getAuthorizationHeader: jest.fn().mockResolvedValue(undefined),
    });
    const content = "Look: ![screenshot](/files/system/shot.png)";
    render(
      <ChatMessage
        message={msg({ role: "assistant", content })}
        client={client as unknown as GatewayClient}
      />,
    );

    await waitFor(() => expect(client.getAuthorizationHeader).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryAllByLabelText("screenshot")).toHaveLength(0);
  });

  it("does not render inline images without a gateway client", () => {
    const content = "Look: ![screenshot](/files/system/shot.png)";
    render(<ChatMessage message={msg({ role: "assistant", content })} gatewayUrl="http://localhost:4000" />);
    expect(screen.queryAllByLabelText("screenshot")).toHaveLength(0);
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
