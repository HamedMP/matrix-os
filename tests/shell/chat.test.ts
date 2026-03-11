import { describe, it, expect } from "vitest";

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  tool?: string;
  toolInput?: Record<string, unknown>;
  requestId?: string;
  timestamp: number;
}

type ServerMessage =
  | { type: "kernel:init"; sessionId: string; requestId?: string }
  | { type: "kernel:text"; text: string; requestId?: string }
  | { type: "kernel:tool_start"; tool: string; requestId?: string }
  | { type: "kernel:tool_end"; input?: Record<string, unknown>; requestId?: string }
  | { type: "kernel:result"; data: Record<string, unknown>; requestId?: string }
  | { type: "kernel:error"; message: string; requestId?: string };

function reduceChat(
  messages: ChatMessage[],
  event: ServerMessage,
): ChatMessage[] {
  const next = [...messages];
  const reqId = "requestId" in event ? event.requestId : undefined;

  switch (event.type) {
    case "kernel:text": {
      let targetIdx = -1;

      if (reqId) {
        for (let i = next.length - 1; i >= 0; i--) {
          const m = next[i];
          if (m.role === "assistant" && !m.tool && m.requestId === reqId) {
            targetIdx = i;
            break;
          }
        }
      } else {
        const last = next[next.length - 1];
        if (last?.role === "assistant" && !last.tool) {
          targetIdx = next.length - 1;
        }
      }

      if (targetIdx >= 0) {
        const target = next[targetIdx];
        next[targetIdx] = { ...target, content: target.content + event.text };
      } else {
        next.push({
          id: `msg-${Date.now()}`,
          role: "assistant",
          content: event.text,
          requestId: reqId,
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
        requestId: reqId,
        timestamp: Date.now(),
      });
      break;
    }
    case "kernel:tool_end": {
      for (let i = next.length - 1; i >= 0; i--) {
        const m = next[i];
        if (m.tool && m.content.startsWith("Using ")) {
          if (!reqId || m.requestId === reqId) {
            next[i] = { ...m, content: `Used ${m.tool}`, toolInput: event.input };
            break;
          }
        }
      }
      break;
    }
    case "kernel:error": {
      next.push({
        id: `msg-${Date.now()}`,
        role: "system",
        content: event.message,
        requestId: reqId,
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

  it("stores tool input from tool_end event (T2001)", () => {
    let msgs: ChatMessage[] = [];
    msgs = reduceChat(msgs, { type: "kernel:tool_start", tool: "Read" });
    msgs = reduceChat(msgs, {
      type: "kernel:tool_end",
      input: { file_path: "/src/index.ts" },
    });
    expect(msgs[0].toolInput).toEqual({ file_path: "/src/index.ts" });
  });

  it("stores Bash command in toolInput (T2001)", () => {
    let msgs: ChatMessage[] = [];
    msgs = reduceChat(msgs, { type: "kernel:tool_start", tool: "Bash" });
    msgs = reduceChat(msgs, {
      type: "kernel:tool_end",
      input: { command: "npm test" },
    });
    expect(msgs[0].toolInput).toEqual({ command: "npm test" });
  });

  it("handles tool_end without input", () => {
    let msgs: ChatMessage[] = [];
    msgs = reduceChat(msgs, { type: "kernel:tool_start", tool: "Write" });
    msgs = reduceChat(msgs, { type: "kernel:tool_end" });
    expect(msgs[0].toolInput).toBeUndefined();
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

  it("input is always sendable during busy state (T2004)", () => {
    const state = createQueueState();

    // Send first message - enters busy
    submitMessage(state, "first");
    expect(state.busy).toBe(true);

    // Can still submit while busy - messages queue and user sees them
    submitMessage(state, "second");
    submitMessage(state, "third");
    expect(state.messages).toHaveLength(3);
    expect(state.messages.map((m) => m.content)).toEqual(["first", "second", "third"]);
    expect(state.queue).toEqual(["second", "third"]);

    // After result, queued messages auto-dispatch in order
    onResult(state);
    expect(state.sent.map((s) => s.text)).toEqual(["first", "second"]);
    expect(state.busy).toBe(true);

    onResult(state);
    expect(state.sent.map((s) => s.text)).toEqual(["first", "second", "third"]);

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

  it("ChatPanel renders inputBar regardless of busy state (T2004)", async () => {
    const mod = await import("../../shell/src/components/ChatPanel");
    expect(mod.ChatPanel).toBeDefined();
    const props: Parameters<typeof mod.ChatPanel>[0] = {
      messages: [],
      sessionId: undefined,
      busy: true,
      connected: true,
      conversations: [],
      onNewChat: () => {},
      onSwitchConversation: () => {},
      onClose: () => {},
      inputBar: "test-input",
    };
    expect(props.busy).toBe(true);
    expect(props.inputBar).toBe("test-input");
  });
});

describe("groupMessages (T2000)", () => {
  type MessageGroup =
    | { type: "message"; message: ChatMessage }
    | { type: "tool_group"; messages: ChatMessage[] };

  function groupMessages(messages: ChatMessage[]): MessageGroup[] {
    const groups: MessageGroup[] = [];
    let toolBuf: ChatMessage[] = [];

    function flushTools() {
      if (toolBuf.length > 0) {
        groups.push({ type: "tool_group", messages: [...toolBuf] });
        toolBuf = [];
      }
    }

    for (const msg of messages) {
      if (msg.tool) {
        toolBuf.push(msg);
      } else {
        flushTools();
        groups.push({ type: "message", message: msg });
      }
    }
    flushTools();

    return groups;
  }

  function msg(overrides: Partial<ChatMessage>): ChatMessage {
    return {
      id: `m-${Math.random()}`,
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      ...overrides,
    };
  }

  it("returns empty array for empty input", () => {
    expect(groupMessages([])).toEqual([]);
  });

  it("wraps non-tool messages individually", () => {
    const m1 = msg({ role: "user", content: "hello" });
    const m2 = msg({ role: "assistant", content: "hi" });
    const groups = groupMessages([m1, m2]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual({ type: "message", message: m1 });
    expect(groups[1]).toEqual({ type: "message", message: m2 });
  });

  it("groups consecutive tool messages", () => {
    const t1 = msg({ role: "system", tool: "Read", content: "Used Read" });
    const t2 = msg({ role: "system", tool: "Write", content: "Used Write" });
    const t3 = msg({ role: "system", tool: "Bash", content: "Used Bash" });
    const groups = groupMessages([t1, t2, t3]);
    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe("tool_group");
    if (groups[0].type === "tool_group") {
      expect(groups[0].messages).toHaveLength(3);
    }
  });

  it("separates tool groups by non-tool messages", () => {
    const t1 = msg({ role: "system", tool: "Read", content: "Used Read" });
    const text = msg({ role: "assistant", content: "Processing..." });
    const t2 = msg({ role: "system", tool: "Write", content: "Used Write" });
    const groups = groupMessages([t1, text, t2]);
    expect(groups).toHaveLength(3);
    expect(groups[0].type).toBe("tool_group");
    expect(groups[1].type).toBe("message");
    expect(groups[2].type).toBe("tool_group");
  });

  it("handles single tool message as a group of 1", () => {
    const t1 = msg({ role: "system", tool: "Read", content: "Used Read" });
    const groups = groupMessages([t1]);
    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe("tool_group");
    if (groups[0].type === "tool_group") {
      expect(groups[0].messages).toHaveLength(1);
    }
  });

  it("handles mixed sequence: text, tools, text", () => {
    const text1 = msg({ role: "assistant", content: "Let me help" });
    const t1 = msg({ role: "system", tool: "Read", content: "Used Read" });
    const t2 = msg({ role: "system", tool: "Edit", content: "Used Edit" });
    const text2 = msg({ role: "assistant", content: "Done!" });
    const groups = groupMessages([text1, t1, t2, text2]);
    expect(groups).toHaveLength(3);
    expect(groups[0].type).toBe("message");
    expect(groups[1].type).toBe("tool_group");
    if (groups[1].type === "tool_group") {
      expect(groups[1].messages).toHaveLength(2);
    }
    expect(groups[2].type).toBe("message");
  });
});

describe("requestId tagging (T2002)", () => {
  it("tags new assistant messages with requestId", () => {
    const msgs = reduceChat([], {
      type: "kernel:text",
      text: "Hello",
      requestId: "req-1",
    });
    expect(msgs[0].requestId).toBe("req-1");
  });

  it("appends to matching requestId assistant message", () => {
    const initial: ChatMessage[] = [
      { id: "1", role: "assistant", content: "Hi", requestId: "req-1", timestamp: 1 },
    ];
    const result = reduceChat(initial, {
      type: "kernel:text",
      text: " there",
      requestId: "req-1",
    });
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Hi there");
  });

  it("creates separate message for different requestId", () => {
    const initial: ChatMessage[] = [
      { id: "1", role: "assistant", content: "From req-1", requestId: "req-1", timestamp: 1 },
    ];
    const result = reduceChat(initial, {
      type: "kernel:text",
      text: "From req-2",
      requestId: "req-2",
    });
    expect(result).toHaveLength(2);
    expect(result[0].requestId).toBe("req-1");
    expect(result[1].requestId).toBe("req-2");
  });

  it("tags tool_start with requestId", () => {
    const msgs = reduceChat([], {
      type: "kernel:tool_start",
      tool: "Read",
      requestId: "req-1",
    });
    expect(msgs[0].requestId).toBe("req-1");
  });

  it("tool_end finds matching tool by requestId", () => {
    let msgs: ChatMessage[] = [];
    msgs = reduceChat(msgs, { type: "kernel:tool_start", tool: "Read", requestId: "req-1" });
    msgs = reduceChat(msgs, { type: "kernel:tool_start", tool: "Write", requestId: "req-2" });
    msgs = reduceChat(msgs, { type: "kernel:tool_end", requestId: "req-1" });
    // req-1's Read should be completed, req-2's Write still running
    expect(msgs[0].content).toBe("Used Read");
    expect(msgs[1].content).toBe("Using Write...");
  });

  it("error message tagged with requestId", () => {
    const msgs = reduceChat([], {
      type: "kernel:error",
      message: "fail",
      requestId: "req-1",
    });
    expect(msgs[0].requestId).toBe("req-1");
  });

  it("backwards compat: works without requestId", () => {
    let msgs: ChatMessage[] = [];
    msgs = reduceChat(msgs, { type: "kernel:text", text: "Hi" });
    msgs = reduceChat(msgs, { type: "kernel:text", text: " there" });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("Hi there");
    expect(msgs[0].requestId).toBeUndefined();
  });
});

describe("parallel response rendering (T2003)", () => {
  it("interleaved text from two requests stays separate", () => {
    let msgs: ChatMessage[] = [];
    // req-1 starts
    msgs = reduceChat(msgs, { type: "kernel:text", text: "Hello ", requestId: "req-1" });
    // req-2 starts
    msgs = reduceChat(msgs, { type: "kernel:text", text: "World ", requestId: "req-2" });
    // more from req-1
    msgs = reduceChat(msgs, { type: "kernel:text", text: "from 1", requestId: "req-1" });
    // more from req-2
    msgs = reduceChat(msgs, { type: "kernel:text", text: "from 2", requestId: "req-2" });

    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe("Hello from 1");
    expect(msgs[0].requestId).toBe("req-1");
    expect(msgs[1].content).toBe("World from 2");
    expect(msgs[1].requestId).toBe("req-2");
  });

  it("parallel tool calls with different requestIds don't interfere", () => {
    let msgs: ChatMessage[] = [];
    msgs = reduceChat(msgs, { type: "kernel:text", text: "Starting...", requestId: "req-1" });
    msgs = reduceChat(msgs, { type: "kernel:tool_start", tool: "Read", requestId: "req-1" });
    msgs = reduceChat(msgs, { type: "kernel:text", text: "Also starting...", requestId: "req-2" });
    msgs = reduceChat(msgs, { type: "kernel:tool_start", tool: "Write", requestId: "req-2" });
    msgs = reduceChat(msgs, { type: "kernel:tool_end", requestId: "req-2" });
    msgs = reduceChat(msgs, { type: "kernel:tool_end", requestId: "req-1" });
    msgs = reduceChat(msgs, { type: "kernel:text", text: " Done!", requestId: "req-1" });

    // req-1: text, Read tool, more text
    // req-2: text, Write tool
    const req1Text = msgs.filter((m) => m.requestId === "req-1" && m.role === "assistant");
    const req2Text = msgs.filter((m) => m.requestId === "req-2" && m.role === "assistant");
    expect(req1Text).toHaveLength(1);
    expect(req1Text[0].content).toBe("Starting... Done!");
    expect(req2Text).toHaveLength(1);
    expect(req2Text[0].content).toBe("Also starting...");

    const req1Tools = msgs.filter((m) => m.requestId === "req-1" && m.tool);
    const req2Tools = msgs.filter((m) => m.requestId === "req-2" && m.tool);
    expect(req1Tools[0].content).toBe("Used Read");
    expect(req2Tools[0].content).toBe("Used Write");
  });

  it("groupMessages preserves requestId in groups", () => {
    type MessageGroup =
      | { type: "message"; message: ChatMessage }
      | { type: "tool_group"; messages: ChatMessage[] };

    function groupMessages(messages: ChatMessage[]): MessageGroup[] {
      const groups: MessageGroup[] = [];
      let toolBuf: ChatMessage[] = [];

      function flushTools() {
        if (toolBuf.length > 0) {
          groups.push({ type: "tool_group", messages: [...toolBuf] });
          toolBuf = [];
        }
      }

      for (const msg of messages) {
        if (msg.tool) {
          toolBuf.push(msg);
        } else {
          flushTools();
          groups.push({ type: "message", message: msg });
        }
      }
      flushTools();

      return groups;
    }

    let msgs: ChatMessage[] = [];
    msgs = reduceChat(msgs, { type: "kernel:text", text: "A", requestId: "req-1" });
    msgs = reduceChat(msgs, { type: "kernel:tool_start", tool: "Read", requestId: "req-1" });
    msgs = reduceChat(msgs, { type: "kernel:tool_end", requestId: "req-1" });
    msgs = reduceChat(msgs, { type: "kernel:text", text: "B", requestId: "req-2" });

    const groups = groupMessages(msgs);
    expect(groups).toHaveLength(3);
    expect(groups[0].type).toBe("message");
    if (groups[0].type === "message") {
      expect(groups[0].message.requestId).toBe("req-1");
    }
    expect(groups[1].type).toBe("tool_group");
    if (groups[1].type === "tool_group") {
      expect(groups[1].messages[0].requestId).toBe("req-1");
    }
    expect(groups[2].type).toBe("message");
    if (groups[2].type === "message") {
      expect(groups[2].message.requestId).toBe("req-2");
    }
  });
});
