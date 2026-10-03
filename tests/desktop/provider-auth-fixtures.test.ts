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
