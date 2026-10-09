import { createServer, request } from "node:http";
import { CanonicalChatDetailResponseSchema, CanonicalChatRecordSchema, ProviderSettingsSnapshotSchema } from "@matrix-os/contracts";
import { createCanonicalChatFixture } from "../../../contracts/fixtures/canonical-chat";
import { providerAuthSettingsSnapshot } from "./provider-auth-gateway";
import { startStubGateway } from "./stub-gateway";

export const STATUS_CHAT_TITLE = "UI status review (synthetic)";
export const STATUS_MODEL = "gpt-5.6-luna";
export const LONG_STATUS_MODEL = `gpt-5.6-luna-${"long-model-name-".repeat(8)}`;

/** Loopback-only synthetic state for UI layout; no provider calls or account credentials. */
export async function startChatStatusQuotaGateway() {
  const base = await startStubGateway();
  let usedBasisPoints = 7100;
  let model = STATUS_MODEL;
  let completed = false;
  const fixture = createCanonicalChatFixture("running").snapshot;
  const now = new Date().toISOString();
  const record = () => CanonicalChatRecordSchema.parse({ chat: { id: fixture.chat.id, lifecycle: "active", attention: "none", revision: 1, messageCount: 1,
    ownerScope: { type: "personal", ownerId: "user-1" }, title: STATUS_CHAT_TITLE,
    currentSelection: { instanceId: "codex_fixture", model }, createdAt: now, updatedAt: now },
    ...(!completed ? { activeRun: fixture.chat.activeRun } : {}) });
  const detail = () => CanonicalChatDetailResponseSchema.parse({ record: record(), messages: fixture.messages,
    turns: fixture.turns.map(turn => ({ ...turn, status: completed ? "completed" : "running" })),
    runs: fixture.runs.map(run => ({ ...run, selection: { ...run.selection, model }, startedAt: now, createdAt: now, updatedAt: now,
      ...(completed ? { status: "completed", outcome: "completed", completedAt: now } : {}) })),
    activities: completed ? [{ id: "checked_files", chatId: fixture.chat.id, runId: fixture.runs[0]!.id, occurredAt: now,
      type: "tool.progress", toolCallId: "checked_files", label: "Checked files", status: "completed" }] : fixture.activities, queuedTurns: [] });
  const settings = () => {
    const snapshot = providerAuthSettingsSnapshot(true);
    snapshot.modelProviders = [{ id: "openai", displayName: "OpenAI", models: [{ id: "openai/gpt-5.6-luna", displayName: "GPT-5.6 Luna", enabled: true }] }];
    snapshot.accounts[0] = { ...snapshot.accounts[0]!, providerId: "openai", displayName: "Synthetic ChatGPT account", authMethod: "oauth" };
    snapshot.accessSources[0] = { ...snapshot.accessSources[0]!, providerId: "openai", displayName: "Synthetic ChatGPT account", eligibleModelIds: ["openai/gpt-5.6-luna"],
      usage: { kind: "subscription_allowance", authority: "provider_allowance", state: "current", scope: "account",
        usedBasisPoints, resetsAt: "2026-10-14T12:00:00Z", asOf: now } };
    snapshot.harnesses[0] = { ...snapshot.harnesses[0]!, harness: "codex", displayName: "Codex", loginMethods: ["oauth"], recommendedLoginMethod: "oauth",
      route: { kind: "fixed", providerId: "openai", modelId: "openai/gpt-5.6-luna" } };
    return ProviderSettingsSnapshotSchema.parse(snapshot);
  };
  // Validate before opening a window so malformed synthetic state fails directly.
  record(); detail(); settings();
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const json = (value: unknown) => { res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)); };
    if (path === "/api/chat-agents") return json({ enabled: true, agents: [] });
    if (path === "/api/chats") return json({ items: [record()] });
    if (path === `/api/chats/${fixture.chat.id}`) return json(detail());
    if (path === `/api/chats/${fixture.chat.id}/bot`) return json({ agentId: null });
    if (path === `/api/chats/${fixture.chat.id}/read-state`) { req.resume(); return json(record()); }
    if (path === "/api/ai/provider-settings") return json(settings());
    const upstream = request(new URL(req.url ?? "/", base.url), { method: req.method, headers: req.headers, timeout: 10_000 }, response => {
      res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
    });
    upstream.on("timeout", () => upstream.destroy(new Error("Fixture timeout")));
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    setUsedBasisPoints(value: number) { usedBasisPoints = value; },
    setModel(value: string) { model = value; record(); detail(); },
    setCompleted() { completed = true; record(); detail(); },
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await base.close(); } };
}
