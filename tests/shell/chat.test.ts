import { describe, it, expect } from "vitest";

import { groupMessages, reduceChat, type ChatMessage } from "../../shell/src/lib/chat.js";

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

describe("groupMessages (T2000)", () => {
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

    // req-1: text, Read tool, then more text in a separate bubble
    // req-2: text, Write tool
    const req1Text = msgs.filter((m) => m.requestId === "req-1" && m.role === "assistant");
    const req2Text = msgs.filter((m) => m.requestId === "req-2" && m.role === "assistant");
    expect(req1Text).toHaveLength(2);
    expect(req1Text[0].content).toBe("Starting...");
    expect(req1Text[1].content).toBe(" Done!");
    expect(req2Text).toHaveLength(1);
    expect(req2Text[0].content).toBe("Also starting...");

    const req1Tools = msgs.filter((m) => m.requestId === "req-1" && m.tool);
    const req2Tools = msgs.filter((m) => m.requestId === "req-2" && m.tool);
    expect(req1Tools[0].content).toBe("Used Read");
    expect(req2Tools[0].content).toBe("Used Write");
  });

  it("post-tool text gets its own bubble within same requestId", () => {
    let msgs: ChatMessage[] = [];
    msgs = reduceChat(msgs, { type: "kernel:text", text: "Let me check...", requestId: "req-1" });
    msgs = reduceChat(msgs, { type: "kernel:tool_start", tool: "Read", requestId: "req-1" });
    msgs = reduceChat(msgs, { type: "kernel:tool_end", requestId: "req-1" });
    msgs = reduceChat(msgs, { type: "kernel:text", text: "Here's what I found", requestId: "req-1" });

    const assistants = msgs.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(2);
    expect(assistants[0].content).toBe("Let me check...");
    expect(assistants[1].content).toBe("Here's what I found");
  });

  it("second turn response does not append to first turn", () => {
    let msgs: ChatMessage[] = [];
    // Turn 1
    msgs = reduceChat(msgs, { type: "kernel:text", text: "Answer 1", requestId: "req-1" });
    msgs = reduceChat(msgs, { type: "kernel:tool_start", tool: "Read", requestId: "req-1" });
    msgs = reduceChat(msgs, { type: "kernel:tool_end", requestId: "req-1" });
    msgs = reduceChat(msgs, { type: "kernel:text", text: "After tool", requestId: "req-1" });
    // User message 2
    msgs.push({ id: "user-2", role: "user", content: "Follow-up", timestamp: 2 });
    // Turn 2
    msgs = reduceChat(msgs, { type: "kernel:text", text: "Answer 2", requestId: "req-2" });

    const assistants = msgs.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(3);
    expect(assistants[0].content).toBe("Answer 1");
    expect(assistants[1].content).toBe("After tool");
    expect(assistants[2].content).toBe("Answer 2");
    expect(assistants[2].requestId).toBe("req-2");
  });

  it("groupMessages preserves requestId in groups", () => {
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
