import { createServer, request } from "node:http";
import { createCanonicalChatFixture } from "../../../contracts/fixtures/canonical-chat";
import { startStubGateway, type StubGateway } from "./stub-gateway";

export const fixture = createCanonicalChatFixture("completed").snapshot;
const run = fixture.runs[0]!;
const record = { chat: { id: fixture.chat.id, title: "Subagent activity review", ownerScope: { type: "personal", ownerId: "user-1" },
  lifecycle: "active", attention: "none", revision: 1, messageCount: 2, createdAt: run.createdAt, updatedAt: run.createdAt } };
const detail = { record, turns: fixture.turns, runs: fixture.runs, queuedTurns: [], messages: [
  ...fixture.messages,
  { id: "msg_final", chatId: fixture.chat.id, runId: run.id, turnId: run.turnId, seq: 2, role: "assistant", state: "committed", parts: [{ type: "text", text: "Parent response remains separate." }], createdAt: run.createdAt },
], activities: [
  ...["running", "completed"].map((status, index) => ({
    id: `activity_child_${index}`, sequence: index + 1, chatId: fixture.chat.id, runId: run.id, occurredAt: run.createdAt,
    type: "agent.activity", activityId: "child_arithmetic", kind: "delegation", label: "Arithmetic", status,
    subagent: { agentId: "agent_arithmetic", parentAgentId: "agent_parent", name: "Arithmetic", status,
      ...(status === "completed" ? { result: "437" } : {}) },
  })),
  { id: "activity_failed", sequence: 3, chatId: fixture.chat.id, runId: run.id, occurredAt: run.createdAt,
    type: "agent.activity", activityId: "child_tests", kind: "delegation", label: "Tests", status: "failed",
    subagent: { agentId: "agent_tests", parentAgentId: "agent_parent", name: "Tests", status: "failed", task: "Review the tests" } },
  { id: "activity_waiting", sequence: 4, chatId: fixture.chat.id, runId: run.id, occurredAt: run.createdAt,
    type: "agent.activity", activityId: "child_review", kind: "delegation", label: "Review", status: "running",
    subagent: { agentId: "agent_review", parentAgentId: "agent_parent", name: "Review", status: "waiting" } },
] };

export async function startSubagentGateway() {
let base: StubGateway;
  const server = createServer((req, res) => {
  const path = new URL(req.url!, "http://localhost").pathname;
  const json = (value: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
  if (path === "/api/chats") return json({ items: [record] });
  if (path === `/api/chats/${fixture.chat.id}`) return json(detail);
  if (path === `/api/chats/${fixture.chat.id}/read-state`) { req.resume(); return json(record); }
  const upstream = request(new URL(req.url!, base.url), { method: req.method, headers: req.headers, timeout: 10_000 }, response => {
    res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
  });
  upstream.on("timeout", () => upstream.destroy(new Error("Fixture timeout")));
  upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(upstream);
});


  base = await startStubGateway();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await base.close(); },
  };
}
