import { expect, it } from "vitest";
import { ProviderSettingsSnapshotSchema } from "@matrix-os/contracts";
import { startProviderAuthGateway } from "../e2e/desktop/fixtures/provider-auth-gateway";
import { startAgentsProvidersWorkflowGateway } from "../e2e/desktop/fixtures/agents-providers-workflows";

it("browser-login fixture disconnect disables only the selected agent and preserves authentication", async () => {
  const gateway = await startProviderAuthGateway({inlineClaude: true});
  try {
    gateway.setAuthenticated(true);
    const read = async () => ProviderSettingsSnapshotSchema.parse(await (await fetch(`${gateway.url}/api/ai/provider-settings`, {signal: AbortSignal.timeout(5000)})).json());
    const before = await read();
    expect(before.supportedActions).toContain("set_harness_enabled");
    const response = await fetch(`${gateway.url}/api/ai/provider-settings/actions`, {method: "POST", signal: AbortSignal.timeout(5000), headers: {"content-type": "application/json"}, body: JSON.stringify({type: "set_harness_enabled", harnessInstanceId: "claude_harness", enabled: false, expectedRevision: before.revision, idempotencyKey: "fixture-disable"})});
    expect(response.status).toBe(200);
    const after = await read();
    expect(after.harnesses[0]?.enabled).toBe(false);
    expect(after.accounts[0]?.authState).toBe("authenticated");
    expect(after.revision).toBeGreaterThan(before.revision);
  } finally { await gateway.close(); }
});
it("Figma fixture disconnect leaves Codex credential and other agents intact", async () => {
  const gateway = await startAgentsProvidersWorkflowGateway();
  try {
    const key = await fetch(`${gateway.url}/api/ai/provider-settings/workflows/keys`, {method: "POST", signal: AbortSignal.timeout(5000), headers: {"content-type": "application/json"}, body: JSON.stringify({harnessInstanceId: "codex_harness", providerId: "openai", apiKey: "sk-safe-fixture-valid"})});
    expect(key.status).toBe(200);
    const read = async () => ProviderSettingsSnapshotSchema.parse(await (await fetch(`${gateway.url}/api/ai/provider-settings`, {signal: AbortSignal.timeout(5000)})).json());
    const before = await read();
    expect(before.supportedActions).toContain("set_harness_enabled");
    const response = await fetch(`${gateway.url}/api/ai/provider-settings/actions`, {method: "POST", signal: AbortSignal.timeout(5000), headers: {"content-type": "application/json"}, body: JSON.stringify({type: "set_harness_enabled", harnessInstanceId: "codex_harness", enabled: false, expectedRevision: before.revision, idempotencyKey: "fixture-disable"})});
    expect(response.status).toBe(200);
    const after = await read();
    expect(after.harnesses.find(h => h.id === "codex_harness")?.enabled).toBe(false);
    expect(after.accounts.find(a => a.id === "codex_account")?.authState).toBe("authenticated");
    expect(after.harnesses.find(h => h.id === "claude_harness")).toEqual(before.harnesses.find(h => h.id === "claude_harness"));
    expect(after.revision).toBeGreaterThan(before.revision);
  } finally { await gateway.close(); }
});

it("evicts expired receipts without evicting active workflows or replaying an old ID", async () => {
  let time = Date.now();
  const gateway = await startAgentsProvidersWorkflowGateway({ now: () => time });
  let requestId = 0;
  const post = (path: string, body: object) => fetch(`${gateway.url}${path}`, { method: "POST", signal: AbortSignal.timeout(5000), headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, idempotencyKey: `fixture-request-${++requestId}` }) });
  try {
    const first = await (await post("/api/ai/provider-settings/workflows", { harnessInstanceId: "codex_harness", kind: "login", method: "device_code" })).json();
    time += 300_000;
    let activeId = "";
    for (let index = 0; index < 31; index++) {
      const response = await post("/api/ai/provider-settings/workflows", { harnessInstanceId: "codex_harness", kind: "login", method: "device_code" });
      expect(response.status).toBe(200);
      activeId = (await response.json()).id;
    }
    expect((await post("/api/ai/provider-settings/workflows", { harnessInstanceId: "codex_harness", kind: "login", method: "device_code" })).status).toBe(429);
    time += 300_001;
    expect((await fetch(`${gateway.url}/api/ai/provider-settings/workflows/${first.id}`, { signal: AbortSignal.timeout(5000) })).status).toBe(404);
    expect((await fetch(`${gateway.url}/api/ai/provider-settings/workflows/${activeId}`, { signal: AbortSignal.timeout(5000) })).status).toBe(200);
    const replacement = await post("/api/ai/provider-settings/workflows", { harnessInstanceId: "codex_harness", kind: "login", method: "device_code" });
    expect(replacement.status).toBe(200);
    expect((await replacement.json()).id).not.toBe(first.id);
  } finally { await gateway.close(); }
});

it("reclaims settled receipts at capacity and rejects logs for unadvertised targets", async () => {
  const gateway = await startAgentsProvidersWorkflowGateway();
  const post = (path: string, body: object) => fetch(`${gateway.url}${path}`, { method: "POST", signal: AbortSignal.timeout(5000), headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    let firstId = "";
    for (let index = 0; index < 33; index++) {
      const response = await post("/api/ai/provider-settings/workflows", { harnessInstanceId: "codex_harness", kind: "login", method: "device_code", idempotencyKey: `settled-${index}` });
      expect(response.status).toBe(200);
      const operation = await response.json();
      if (!index) firstId = operation.id;
      await post(`/api/ai/provider-settings/workflows/${operation.id}/cancel`, {});
    }
    expect((await fetch(`${gateway.url}/api/ai/provider-settings/workflows/${firstId}`, { signal: AbortSignal.timeout(5000) })).status).toBe(404);
    expect((await fetch(`${gateway.url}/api/ai/provider-settings/workflows/logs/unadvertised_harness`, { signal: AbortSignal.timeout(5000) })).status).toBe(404);
    expect((await fetch(`${gateway.url}/api/ai/provider-settings/workflows/logs/codex_harness`, { signal: AbortSignal.timeout(5000) })).status).toBe(200);
  } finally { await gateway.close(); }
});

it("keeps an idempotent receipt bound to its request until expiry", async () => {
  let time = Date.now();
  const gateway = await startAgentsProvidersWorkflowGateway({ now: () => time });
  const start = (kind = "login") => fetch(`${gateway.url}/api/ai/provider-settings/workflows`, { method: "POST", signal: AbortSignal.timeout(5000), headers: { "content-type": "application/json" }, body: JSON.stringify({ harnessInstanceId: "codex_harness", kind, ...(kind === "login" ? { method: "device_code" } : {}), idempotencyKey: "same-request" }) });
  try {
    const first = await (await start()).json();
    expect((await (await start()).json()).id).toBe(first.id);
    expect((await start("uninstall")).status).toBe(409);
    time += 600_001;
    expect((await (await start()).json()).id).not.toBe(first.id);
  } finally { await gateway.close(); }
});
