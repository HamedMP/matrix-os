import { expect, it } from "vitest";
import { createCodexMcpElicitations } from "../../packages/gateway/src/coding-agents/codex-mcp-elicitations.mjs";
import { parseCodexExecJsonLine } from "../../packages/gateway/src/coding-agents/codex-events.js";

const request = (id: number) => ({ id, method: "mcpServer/elicitation/request", params: {
  threadId: "thread", turnId: "turn", serverName: "integration", mode: "form",
  message: "Allow operation?", requestedSchema: { type: "object", properties: {} },
} });

function harness() {
  let time = 0;
  const responses: unknown[] = [];
  const events: { approvalId: string }[] = [];
  const bridge = createCodexMcpElicitations({
    send: (value: unknown) => responses.push(value),
    persist: async (event: { approvalId: string }) => { events.push(event); },
    safeText: (text: string) => text,
    now: () => time,
  });
  return { bridge, responses, events, advance: () => { time += 300_001; } };
}

it("expires unanswered confirmation and fences a late approval", async () => {
  const h = harness();
  await h.bridge.handle(request(42), "thread");
  h.advance();
  expect(await h.bridge.decide(h.events[0].approvalId, "approve")).toBe(false);
  expect(h.responses).toEqual([{ id: 42, result: { action: "cancel", content: null } }]);
  expect(h.bridge.size).toBe(0);
});

it("sweeps unattended confirmations once without extending their deadlines", async () => {
  const h = harness();
  await h.bridge.handle(request(42), "thread");
  h.advance();
  await h.bridge.handle(request(42), "thread");
  await h.bridge.sweep();
  await h.bridge.sweep();
  expect(h.responses).toEqual([{ id: 42, result: { action: "cancel", content: null } }]);
  expect(h.events).toHaveLength(2);
  expect(parseCodexExecJsonLine(JSON.stringify(h.events[1]), {
    threadId: "thread_test", now: () => new Date("2026-09-08T00:00:00Z"), nextEventId: () => "evt_test",
  }).events).toEqual([expect.objectContaining({
    type: "approval.resolved", approvalId: h.events[0].approvalId, decision: "cancel",
  })]);
});

it("caps pending confirmations and drains only the outstanding requests", async () => {
  const h = harness();
  for (let id = 1; id <= 21; id++) await h.bridge.handle(request(id), "thread");
  expect(h.bridge.size).toBe(20);
  expect(h.events).toHaveLength(20);
  expect(h.responses).toEqual([{ id: 21, result: { action: "cancel", content: null } }]);
  await h.bridge.drain();
  await h.bridge.drain();
  expect(h.responses).toHaveLength(21);
  expect(h.events).toHaveLength(40);
  expect(await h.bridge.decide(h.events[0].approvalId, "approve")).toBe(false);
});

it("waits for in-flight expiry persistence before terminal drain can complete", async () => {
  let time = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const events: { type: string; approvalId: string }[] = [];
  const responses: unknown[] = [];
  const bridge = createCodexMcpElicitations({
    send: (value: unknown) => responses.push(value),
    persist: async (event: { type: string; approvalId: string }) => {
      if (event.type === "matrix.codex.approval.resolved") await gate;
      events.push(event);
    },
    safeText: (text: string) => text,
    now: () => time,
  });
  await bridge.handle(request(42), "thread");
  time = 300_001;
  const expiry = bridge.sweep();
  let drained = false;
  const drain = bridge.drain().then(() => { drained = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    expect(drained).toBe(false);
    expect(await bridge.decide(events[0].approvalId, "approve")).toBe(false);
    await bridge.handle(request(42), "thread");
    expect(events).toHaveLength(1);
    expect(responses).toEqual([]);
  } finally {
    release();
    await Promise.all([expiry, drain]);
  }
  expect(drained).toBe(true);
  expect(events.map(event => event.type)).toEqual([
    "matrix.codex.approval.requested", "matrix.codex.approval.resolved",
  ]);
  expect(responses).toEqual([{ id: 42, result: { action: "cancel", content: null } }]);
  expect(bridge.size).toBe(0);
});

it("does not report a successful drain when expiry persistence failed", async () => {
  let time = 0;
  let resolutionWrites = 0;
  const failure = new Error("storage unavailable");
  const responses: unknown[] = [];
  const events: { approvalId: string }[] = [];
  const bridge = createCodexMcpElicitations({
    send: (value: unknown) => responses.push(value),
    persist: async (event: { type: string; approvalId: string }) => {
      if (event.type === "matrix.codex.approval.resolved") {
        resolutionWrites++;
        throw failure;
      }
      events.push(event);
    },
    safeText: (text: string) => text,
    now: () => time,
  });
  await bridge.handle(request(42), "thread");
  time = 300_001;
  await expect(bridge.sweep()).rejects.toBe(failure);
  await expect(bridge.drain()).rejects.toBe(failure);
  expect(await bridge.decide(events[0].approvalId, "approve")).toBe(false);
  expect(resolutionWrites).toBe(1);
  expect(responses).toEqual([{ id: 42, result: { action: "cancel", content: null } }]);
});
