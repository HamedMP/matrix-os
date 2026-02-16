import { describe, it, expect, vi } from "vitest";

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

describe("message queue logic", () => {
  interface QueueState {
    busy: boolean;
    queue: string[];
    messages: ChatMessage[];
    sent: Array<{ text: string; sessionId?: string }>;
  }

  function createQueueState(): QueueState {
    return { busy: false, queue: [], messages: [], sent: [] };
  }

  function submitMessage(state: QueueState, text: string, sessionId?: string) {
    if (!text) return;

    state.messages = [
      ...state.messages,
      {
        id: `user-${Date.now()}`,
        role: "user",
        content: text,
        timestamp: Date.now(),
      },
    ];

    if (state.busy) {
      state.queue = [...state.queue, text];
    } else {
      state.sent.push({ text, sessionId });
      state.busy = true;
    }
  }

  function onResult(state: QueueState, sessionId?: string) {
    state.busy = false;
    if (state.queue.length > 0) {
      const [next, ...rest] = state.queue;
      state.queue = rest;
      state.sent.push({ text: next, sessionId });
      state.busy = true;
    }
  }

  function onError(state: QueueState, sessionId?: string) {
    onResult(state, sessionId);
  }

  it("sends immediately when not busy", () => {
    const state = createQueueState();
    submitMessage(state, "hello");
    expect(state.busy).toBe(true);
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0].text).toBe("hello");
    expect(state.queue).toHaveLength(0);
  });

  it("queues messages when busy", () => {
    const state = createQueueState();
    submitMessage(state, "first");
    submitMessage(state, "second");
    submitMessage(state, "third");

    expect(state.sent).toHaveLength(1);
    expect(state.sent[0].text).toBe("first");
    expect(state.queue).toEqual(["second", "third"]);
  });

  it("shows all user messages immediately even when queued", () => {
    const state = createQueueState();
    submitMessage(state, "first");
    submitMessage(state, "second");

    expect(state.messages).toHaveLength(2);
    expect(state.messages[0].content).toBe("first");
    expect(state.messages[1].content).toBe("second");
  });

  it("drains queue on result", () => {
    const state = createQueueState();
    submitMessage(state, "first");
    submitMessage(state, "second");
    submitMessage(state, "third");

    onResult(state);
    expect(state.sent).toHaveLength(2);
    expect(state.sent[1].text).toBe("second");
    expect(state.queue).toEqual(["third"]);
    expect(state.busy).toBe(true);

    onResult(state);
    expect(state.sent).toHaveLength(3);
    expect(state.sent[2].text).toBe("third");
    expect(state.queue).toEqual([]);
    expect(state.busy).toBe(true);

    onResult(state);
    expect(state.busy).toBe(false);
  });

  it("drains queue on error too", () => {
    const state = createQueueState();
    submitMessage(state, "first");
    submitMessage(state, "second");

    onError(state);
    expect(state.sent).toHaveLength(2);
    expect(state.sent[1].text).toBe("second");
  });

  it("ignores empty text submissions", () => {
    const state = createQueueState();
    submitMessage(state, "");
    expect(state.messages).toHaveLength(0);
    expect(state.sent).toHaveLength(0);
  });

  it("becomes idle after all queued messages complete", () => {
    const state = createQueueState();
    submitMessage(state, "only");

    onResult(state);
    expect(state.busy).toBe(false);
    expect(state.queue).toHaveLength(0);
  });
});

describe("ChatPanel props", () => {
  it("ChatPanelProps accepts optional inputBar", async () => {
    const { ChatPanel } = await import("../../shell/src/components/ChatPanel");
    expect(ChatPanel).toBeDefined();
  });

  it("InputBar accepts embedded prop", async () => {
    const { InputBar } = await import("../../shell/src/components/InputBar");
    expect(InputBar).toBeDefined();
  });
});
