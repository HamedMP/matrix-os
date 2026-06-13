import { describe, expect, it } from "vitest";
import {
  groupMessages,
  reduceChat,
  type ChatEvent,
  type ChatMessage,
} from "@desktop/renderer/src/lib/chat";

function userMsg(content: string, requestId?: string): ChatMessage {
  return { id: `u-${content}`, role: "user", content, requestId, timestamp: 1 };
}

function reduceAll(messages: ChatMessage[], events: ChatEvent[]): ChatMessage[] {
  return events.reduce((acc, evt) => reduceChat(acc, evt), messages);
}

describe("reduceChat: text delta accumulation", () => {
  it("accumulates deltas onto the last assistant message without requestId", () => {
    const out = reduceAll(
      [userMsg("hi")],
      [
        { type: "kernel:text", text: "Hel" },
        { type: "kernel:text", text: "lo" },
      ],
    );
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ role: "assistant", content: "Hello" });
  });

  it("accumulates deltas onto the matching requestId assistant message", () => {
    const out = reduceAll(
      [userMsg("hi", "r1")],
      [
        { type: "kernel:text", text: "A", requestId: "r1" },
        { type: "kernel:text", text: "B", requestId: "r1" },
      ],
    );
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ role: "assistant", content: "AB", requestId: "r1" });
  });

  it("creates a new assistant bubble when last message is a user message", () => {
    const out = reduceChat([userMsg("hi")], { type: "kernel:text", text: "yo" });
    expect(out).toHaveLength(2);
    expect(out[1]!.role).toBe("assistant");
  });

  it("isolates interleaved requestIds into separate bubbles", () => {
    const out = reduceAll(
      [],
      [
        { type: "kernel:text", text: "one-", requestId: "r1" },
        { type: "kernel:text", text: "two-", requestId: "r2" },
        { type: "kernel:text", text: "1", requestId: "r1" },
        { type: "kernel:text", text: "2", requestId: "r2" },
      ],
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ content: "one-1", requestId: "r1" });
    expect(out[1]).toMatchObject({ content: "two-2", requestId: "r2" });
  });
});

describe("reduceChat: tool lifecycle", () => {
  it("kernel:tool_start appends a Using system message", () => {
    const out = reduceChat([], { type: "kernel:tool_start", tool: "Read", requestId: "r1" });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      role: "system",
      content: "Using Read...",
      tool: "Read",
      requestId: "r1",
    });
  });

  it("kernel:tool_end marks the matching tool message Used and records toolInput", () => {
    const out = reduceAll(
      [],
      [
        { type: "kernel:tool_start", tool: "Read", requestId: "r1" },
        { type: "kernel:tool_end", input: { path: "/tmp/x" }, requestId: "r1" },
      ],
    );
    expect(out[0]).toMatchObject({
      content: "Used Read",
      tool: "Read",
      toolInput: { path: "/tmp/x" },
    });
  });

  it("kernel:tool_end only ends the tool from the same request", () => {
    const out = reduceAll(
      [],
      [
        { type: "kernel:tool_start", tool: "Read", requestId: "r1" },
        { type: "kernel:tool_start", tool: "Bash", requestId: "r2" },
        { type: "kernel:tool_end", input: {}, requestId: "r1" },
      ],
    );
    expect(out[0]!.content).toBe("Used Read");
    expect(out[1]!.content).toBe("Using Bash...");
  });

  it("splits text after a tool call in the same request into a new bubble", () => {
    const out = reduceAll(
      [],
      [
        { type: "kernel:text", text: "before", requestId: "r1" },
        { type: "kernel:tool_start", tool: "Read", requestId: "r1" },
        { type: "kernel:tool_end", input: {}, requestId: "r1" },
        { type: "kernel:text", text: "after", requestId: "r1" },
      ],
    );
    expect(out).toHaveLength(3);
    expect(out[0]!.content).toBe("before");
    expect(out[1]!.content).toBe("Used Read");
    expect(out[2]).toMatchObject({ role: "assistant", content: "after", requestId: "r1" });
  });

  it("does not split bubbles across different requestIds", () => {
    const out = reduceAll(
      [],
      [
        { type: "kernel:text", text: "one", requestId: "r1" },
        { type: "kernel:tool_start", tool: "Read", requestId: "r2" },
        { type: "kernel:text", text: "+more", requestId: "r1" },
      ],
    );
    expect(out).toHaveLength(2);
    expect(out[0]!.content).toBe("one+more");
  });
});

describe("reduceChat: abort and error", () => {
  it("kernel:aborted marks in-flight tool messages Stopped and appends Stopped.", () => {
    const out = reduceAll(
      [],
      [
        { type: "kernel:tool_start", tool: "Bash", requestId: "r1" },
        { type: "kernel:aborted", requestId: "r1" },
      ],
    );
    expect(out).toHaveLength(2);
    expect(out[0]!.content).toBe("Stopped Bash");
    expect(out[1]).toMatchObject({ role: "system", content: "Stopped." });
  });

  it("kernel:aborted leaves completed tools and other requests alone", () => {
    const out = reduceAll(
      [],
      [
        { type: "kernel:tool_start", tool: "Read", requestId: "r1" },
        { type: "kernel:tool_end", input: {}, requestId: "r1" },
        { type: "kernel:tool_start", tool: "Bash", requestId: "r2" },
        { type: "kernel:aborted", requestId: "r1" },
      ],
    );
    expect(out[0]!.content).toBe("Used Read");
    expect(out[1]!.content).toBe("Using Bash...");
  });

  it("kernel:error appends a system error bubble", () => {
    const out = reduceChat([], {
      type: "kernel:error",
      message: "Something went wrong. Please try again.",
      requestId: "r1",
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      role: "system",
      content: "Something went wrong. Please try again.",
      requestId: "r1",
    });
  });
});

describe("reduceChat: purity", () => {
  it("never mutates the input array or its messages", () => {
    const original: ChatMessage[] = [
      { id: "a1", role: "assistant", content: "Hel", requestId: "r1", timestamp: 1 },
    ];
    Object.freeze(original);
    Object.freeze(original[0]);
    const out = reduceChat(original, { type: "kernel:text", text: "lo", requestId: "r1" });
    expect(original[0]!.content).toBe("Hel");
    expect(out[0]!.content).toBe("Hello");
    expect(out).not.toBe(original);
    expect(out[0]).not.toBe(original[0]);
  });

  it("returns a fresh array for unhandled event types", () => {
    const original: ChatMessage[] = [userMsg("hi")];
    const out = reduceChat(original, { type: "kernel:result", requestId: "r1" });
    expect(out).toEqual(original);
    expect(out).not.toBe(original);
  });
});

describe("groupMessages", () => {
  it("groups consecutive tool messages and flushes around plain messages", () => {
    const messages: ChatMessage[] = [
      { id: "1", role: "user", content: "hi", timestamp: 1 },
      { id: "2", role: "system", content: "Used Read", tool: "Read", timestamp: 2 },
      { id: "3", role: "system", content: "Used Bash", tool: "Bash", timestamp: 3 },
      { id: "4", role: "assistant", content: "done", timestamp: 4 },
    ];
    const groups = groupMessages(messages);
    expect(groups).toHaveLength(3);
    expect(groups[0]).toMatchObject({ type: "message" });
    expect(groups[1]).toMatchObject({ type: "tool_group" });
    expect((groups[1] as { messages: ChatMessage[] }).messages).toHaveLength(2);
    expect(groups[2]).toMatchObject({ type: "message" });
  });

  it("flushes a trailing tool group", () => {
    const groups = groupMessages([
      { id: "1", role: "assistant", content: "x", timestamp: 1 },
      { id: "2", role: "system", content: "Using Read...", tool: "Read", timestamp: 2 },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[1]!.type).toBe("tool_group");
  });

  it("returns empty for no messages", () => {
    expect(groupMessages([])).toEqual([]);
  });
});
