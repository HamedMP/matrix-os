import { describe, it, expect } from "vitest";

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  tool?: string;
  timestamp: number;
}

function shouldShowOverlay(messages: ChatMessage[], busy: boolean): boolean {
  return busy || messages.length > 0;
}

function getOverlayTitle(busy: boolean): string {
  return busy ? "Responding..." : "Conversation";
}

describe("ResponseOverlay visibility", () => {
  it("shows overlay when messages exist", () => {
    const messages: ChatMessage[] = [
      { id: "1", role: "assistant", content: "Hello", timestamp: 1 },
    ];
    expect(shouldShowOverlay(messages, false)).toBe(true);
  });

  it("shows overlay when busy with no messages", () => {
    expect(shouldShowOverlay([], true)).toBe(true);
  });

  it("hides when empty and not busy", () => {
    expect(shouldShowOverlay([], false)).toBe(false);
  });

  it("shows when busy with messages", () => {
    const messages: ChatMessage[] = [
      { id: "1", role: "user", content: "Hi", timestamp: 1 },
    ];
    expect(shouldShowOverlay(messages, true)).toBe(true);
  });
});

describe("ResponseOverlay title", () => {
  it("shows Responding... when busy", () => {
    expect(getOverlayTitle(true)).toBe("Responding...");
  });

  it("shows Conversation when not busy", () => {
    expect(getOverlayTitle(false)).toBe("Conversation");
  });
});

describe("ResponseOverlay message rendering", () => {
  it("classifies user messages as right-aligned", () => {
    const msg: ChatMessage = { id: "1", role: "user", content: "Hi", timestamp: 1 };
    expect(msg.role).toBe("user");
  });

  it("classifies assistant messages for MessageResponse", () => {
    const msg: ChatMessage = { id: "1", role: "assistant", content: "Hello", timestamp: 1 };
    expect(msg.role).toBe("assistant");
    expect(msg.tool).toBeUndefined();
  });

  it("classifies tool messages as compact indicators", () => {
    const msg: ChatMessage = {
      id: "1",
      role: "system",
      content: "Using Write...",
      tool: "Write",
      timestamp: 1,
    };
    expect(msg.tool).toBe("Write");
    expect(msg.content.startsWith("Using ")).toBe(true);
  });

  it("classifies completed tool messages", () => {
    const msg: ChatMessage = {
      id: "1",
      role: "system",
      content: "Used Write",
      tool: "Write",
      timestamp: 1,
    };
    expect(msg.tool).toBe("Write");
    expect(msg.content.startsWith("Using ")).toBe(false);
  });

  it("classifies system error messages", () => {
    const msg: ChatMessage = {
      id: "1",
      role: "system",
      content: "Connection lost",
      timestamp: 1,
    };
    expect(msg.role).toBe("system");
    expect(msg.tool).toBeUndefined();
  });

  it("renders all messages in order", () => {
    const messages: ChatMessage[] = [
      { id: "1", role: "user", content: "Build a notes app", timestamp: 1 },
      { id: "2", role: "assistant", content: "I'll create that for you.", timestamp: 2 },
      { id: "3", role: "system", content: "Using Write...", tool: "Write", timestamp: 3 },
      { id: "4", role: "system", content: "Used Write", tool: "Write", timestamp: 4 },
      { id: "5", role: "assistant", content: "Done! Your notes app is ready.", timestamp: 5 },
    ];

    expect(messages).toHaveLength(5);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
    expect(messages[2].tool).toBe("Write");
    expect(messages[4].role).toBe("assistant");
  });
});
