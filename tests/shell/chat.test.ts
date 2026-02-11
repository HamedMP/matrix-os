import { describe, it, expect } from "vitest";

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  tool?: string;
  timestamp: number;
}

type ServerMessage =
  | { type: "kernel:init"; sessionId: string }
  | { type: "kernel:text"; text: string }
  | { type: "kernel:tool_start"; tool: string }
  | { type: "kernel:tool_end" }
  | { type: "kernel:result"; data: Record<string, unknown> }
  | { type: "kernel:error"; message: string };

function reduceChat(
  messages: ChatMessage[],
  event: ServerMessage,
): ChatMessage[] {
  const next = [...messages];

  switch (event.type) {
    case "kernel:text": {
      const last = next[next.length - 1];
      if (last?.role === "assistant" && !last.tool) {
        last.content += event.text;
      } else {
        next.push({
          id: `msg-${Date.now()}`,
          role: "assistant",
          content: event.text,
          timestamp: Date.now(),
        });
      }
      break;
    }
    case "kernel:tool_start": {
      next.push({
        id: `msg-${Date.now()}`,
        role: "system",
        content: `Using ${event.tool}...`,
        tool: event.tool,
        timestamp: Date.now(),
      });
      break;
    }
    case "kernel:tool_end": {
      const last = next[next.length - 1];
      if (last?.tool) {
        last.content = `Used ${last.tool}`;
      }
      break;
    }
    case "kernel:error": {
      next.push({
        id: `msg-${Date.now()}`,
        role: "system",
        content: event.message,
        timestamp: Date.now(),
      });
      break;
    }
  }

  return next;
}

describe("chat message reducer", () => {
  it("appends text to existing assistant message", () => {
    const initial: ChatMessage[] = [
      { id: "1", role: "assistant", content: "Hello", timestamp: 1 },
    ];
    const result = reduceChat(initial, { type: "kernel:text", text: " world" });
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Hello world");
  });

  it("creates new assistant message when last is user", () => {
    const initial: ChatMessage[] = [
      { id: "1", role: "user", content: "Hi", timestamp: 1 },
    ];
    const result = reduceChat(initial, { type: "kernel:text", text: "Hello" });
    expect(result).toHaveLength(2);
    expect(result[1].role).toBe("assistant");
    expect(result[1].content).toBe("Hello");
  });

  it("creates new assistant message when last has tool", () => {
    const initial: ChatMessage[] = [
      { id: "1", role: "system", content: "Used Write", tool: "Write", timestamp: 1 },
    ];
    const result = reduceChat(initial, { type: "kernel:text", text: "Done" });
    expect(result).toHaveLength(2);
    expect(result[1].content).toBe("Done");
  });

  it("handles tool_start by adding system message", () => {
    const result = reduceChat([], { type: "kernel:tool_start", tool: "Write" });
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("system");
    expect(result[0].content).toBe("Using Write...");
    expect(result[0].tool).toBe("Write");
  });

  it("handles tool_end by updating tool message", () => {
    const initial: ChatMessage[] = [
      { id: "1", role: "system", content: "Using Write...", tool: "Write", timestamp: 1 },
    ];
    const result = reduceChat(initial, { type: "kernel:tool_end" });
    expect(result[0].content).toBe("Used Write");
  });

  it("handles error events", () => {
    const result = reduceChat([], {
      type: "kernel:error",
      message: "Connection lost",
    });
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("system");
    expect(result[0].content).toBe("Connection lost");
  });

  it("streams multiple text deltas into one message", () => {
    let msgs: ChatMessage[] = [];
    msgs = reduceChat(msgs, { type: "kernel:text", text: "I" });
    msgs = reduceChat(msgs, { type: "kernel:text", text: " am" });
    msgs = reduceChat(msgs, { type: "kernel:text", text: " building" });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("I am building");
  });

  it("handles interleaved text and tool events", () => {
    let msgs: ChatMessage[] = [];
    msgs = reduceChat(msgs, { type: "kernel:text", text: "Let me " });
    msgs = reduceChat(msgs, { type: "kernel:text", text: "create that." });
    msgs = reduceChat(msgs, { type: "kernel:tool_start", tool: "Write" });
    msgs = reduceChat(msgs, { type: "kernel:tool_end" });
    msgs = reduceChat(msgs, { type: "kernel:text", text: "Done!" });

    expect(msgs).toHaveLength(3);
    expect(msgs[0].content).toBe("Let me create that.");
    expect(msgs[1].content).toBe("Used Write");
    expect(msgs[2].content).toBe("Done!");
  });

  it("ignores kernel:init for chat display", () => {
    const result = reduceChat([], {
      type: "kernel:init",
      sessionId: "abc",
    });
    expect(result).toHaveLength(0);
  });

  it("handles empty initial state", () => {
    const result = reduceChat([], { type: "kernel:text", text: "Hello" });
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Hello");
  });
});
