import { expect, it } from "vitest";
import { createCodexMcpElicitations } from "../../packages/gateway/src/coding-agents/codex-mcp-elicitations.mjs";

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
  expect(h.bridge.decide(h.events[0].approvalId, "approve")).toBe(false);
  expect(h.responses).toEqual([{ id: 42, result: { action: "cancel", content: null } }]);
  expect(h.bridge.size).toBe(0);
});

it("sweeps unattended confirmations once without extending their deadlines", async () => {
  const h = harness();
  await h.bridge.handle(request(42), "thread");
  h.advance();
  await h.bridge.handle(request(42), "thread");
  h.bridge.sweep();
  h.bridge.sweep();
  expect(h.responses).toEqual([{ id: 42, result: { action: "cancel", content: null } }]);
  expect(h.events).toHaveLength(1);
});

it("caps pending confirmations and drains only the outstanding requests", async () => {
  const h = harness();
  for (let id = 1; id <= 21; id++) await h.bridge.handle(request(id), "thread");
  expect(h.bridge.size).toBe(20);
  expect(h.events).toHaveLength(20);
  expect(h.responses).toEqual([{ id: 21, result: { action: "cancel", content: null } }]);
  h.bridge.drain();
  h.bridge.drain();
  expect(h.responses).toHaveLength(21);
  expect(h.bridge.decide(h.events[0].approvalId, "approve")).toBe(false);
});
