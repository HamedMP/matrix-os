import { expect, it } from "vitest";
import type { AgentThreadEvent } from "@matrix-os/contracts";
import { createCodingPreviewPublisher, fitCodingPreviewEvents } from "../../packages/gateway/src/coding-agents/coding-preview-publisher.js";

const base = { threadId: "thread_output", occurredAt: "2026-10-21T00:00:00.000Z" };
const preview = (eventId: string): AgentThreadEvent => ({ ...base, eventId, type: "assistant.text.delta", messageId: "msg_output", delta: "Preview" });
const control = (eventId: string): AgentThreadEvent => ({ ...base, eventId, type: "user_input.answered", requestId: "question", correlationId: "answer", reason: "cancelled" });

it("bounds pending publishing while continuing ordinary protocol consumption", async () => {
  let release!: () => void;
  const received: AgentThreadEvent[] = [];
  const publisher = createCodingPreviewPublisher(async batch => {
    received.push(...batch.events);
    if (received.length === 1) await new Promise<void>(resolve => { release = resolve; });
  }, 2);
  publisher.queue({ events: [preview("first")] });
  publisher.queue({ events: [preview("second"), preview("third")] });
  publisher.queue({ events: [preview("omitted")] });
  await Promise.resolve();
  expect(received.map(event => event.eventId)).toEqual(["first"]);
  expect(publisher.truncated).toBe(true);
  release();
  await publisher.finished();
});
it("reserves available preview space for input controls and fails closed if they cannot fit", () => {
  expect(fitCodingPreviewEvents([preview("old"), control("answer")], 1)).toEqual([control("answer")]);
  expect(() => fitCodingPreviewEvents([control("one"), control("two")], 1)).toThrow(RangeError);
});

it("evicts queued display for a later control without replaying an in-flight publish", async () => {
  let release!: () => void;
  const received: string[] = [];
  const publisher = createCodingPreviewPublisher(async batch => {
    received.push(...batch.events.map(event => event.eventId));
    if (received.length === 1) await new Promise<void>(resolve => { release = resolve; });
  }, 2);
  publisher.queue({ events: [preview("inflight")] });
  await Promise.resolve();
  try {
    publisher.queue({ events: [preview("queued_one"), preview("queued_two")] });
    publisher.queue({ events: [control("answer")] });
  } finally { release(); }
  await publisher.finished();
  expect(received.filter(id => id === "inflight")).toHaveLength(1);
  expect(received).toContain("answer");
  expect(received.filter(id => id.startsWith("queued_"))).toHaveLength(1);
});

it("preserves a successful tool completion when queued output fills the preview", async () => {
  let release!: () => void;
  const received: AgentThreadEvent[] = [];
  const publisher = createCodingPreviewPublisher(async batch => {
    received.push(...batch.events);
    if (received.length === 1) await new Promise<void>(resolve => { release = resolve; });
  }, 2);
  const completed: AgentThreadEvent = { ...base, eventId: "completed", type: "tool.completed", toolCallId: "tool_one", outcome: "success" };
  publisher.queue({ events: [{ ...base, eventId: "started", type: "tool.started", toolCallId: "tool_one", displayName: "Run command", kind: "command" }] });
  await Promise.resolve();
  try {
    publisher.queue({ events: [preview("queued_one"), preview("queued_two")] });
    publisher.queue({ events: [completed] });
  } finally { release(); }
  await publisher.finished();
  expect(received.filter(event => event.eventId === "started")).toHaveLength(1);
  expect(received).toContainEqual(completed);
  expect(received.filter(event => event.eventId.startsWith("queued_"))).toHaveLength(1);
  expect(publisher.truncated).toBe(true);
  expect(publisher.failure).toBeUndefined();
});

it("bounds one hung publish independently of the whole busy turn", async () => {
  const { vi } = await import("vitest");
  vi.useFakeTimers();
  const publisher = createCodingPreviewPublisher(async () => new Promise<void>(() => undefined), 2);
  try {
    publisher.queue({ events: [preview("hung")] });
    await vi.advanceTimersByTimeAsync(30_001);
    await publisher.finished();
    expect(publisher.failure).toBeInstanceOf(Error);
  } finally { vi.useRealTimers(); }
});

it("stops waiting for an uncooperative publication immediately on caller Stop", async () => {
  const signal = new AbortController();
  const publisher = createCodingPreviewPublisher(async () => new Promise<void>(() => undefined), 2, { signal: signal.signal });
  publisher.queue({ events: [preview("hung")] });
  await Promise.resolve();
  signal.abort();
  await publisher.finished();
  expect(publisher.failure).toBeInstanceOf(Error);
});

it.each(["queued start", "full queue before tool batch"])("keeps queued tool identity through preview eviction: %s", async scenario => {
  let release!: () => void;
  const received: AgentThreadEvent[] = [];
  const publisher = createCodingPreviewPublisher(async batch => {
    received.push(...batch.events);
    if (received.length === 1) await new Promise<void>(resolve => { release = resolve; });
  }, 2);
  const started: AgentThreadEvent = { ...base, eventId: "started", type: "tool.started",
    toolCallId: "tool_one", displayName: "Run command", kind: "command" };
  const completed: AgentThreadEvent = { ...base, eventId: "completed", type: "tool.completed",
    toolCallId: "tool_one", outcome: "success" };
  publisher.queue({ events: [preview("inflight")] });
  await Promise.resolve();
  try {
    if (scenario === "queued start") {
      publisher.queue({ events: [started, preview("queued")] });
      publisher.queue({ events: [completed] });
    } else {
      publisher.queue({ events: [preview("queued_one"), preview("queued_two")] });
      publisher.queue({ events: [started, preview("tool_preview"), completed] });
    }
  } finally { release(); }
  await publisher.finished();
  expect(received.map(event => event.eventId)).toEqual(["inflight", "started", "completed"]);
  expect(received[1]).toMatchObject({ type: "tool.started", toolCallId: "tool_one", displayName: "Run command", kind: "command" });
  expect(publisher.truncated).toBe(true);
  expect(publisher.failure).toBeUndefined();
});
