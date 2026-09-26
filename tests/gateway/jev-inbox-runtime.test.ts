import { expect, it, vi } from "vitest";
import { createJevInboxRuntime } from "../../packages/gateway/src/jev/inbox-runtime.js";
import { saved } from "../desktop/chat-agents-fixture";
import type { ChatAgent } from "@matrix-os/contracts";
import type { HermesJevScope } from "../../packages/gateway/src/chat/hermes-integration-capability.js";
const owner = "owner_fixture";
const scope: HermesJevScope = { kind: "jev_inbox_preview", runId: "run_fixture", agentId: saved.id, revision: 1,
  account: { service: "gmail", accountLabel: "Work", connectionId: "conn_fixture", expectedEmail: "me@example.test" } };
const agent: ChatAgent = { ...saved, selection: { instanceId: "hermes_default", model: "anthropic:claude-sonnet-4-6" },
  recipe: { skills: ["matrix-jev-email-triage", "matrix-integrations"], integrations: [{ service: "gmail", accountLabel: "Work" }], output: "Read-only proposals",
    jevInboxTriage: { version: 1, ownerId: owner, ...scope.account } } };
function fixture(mode = "ready") {
  const getAgent = vi.fn(async () => mode === "missing" ? null : { ...agent, revision: mode === "stale" ? 2 : 1 });
  const credentials = vi.fn(async () => {
    if (mode === "unsupported") throw new Error("fixture unsupported");
    return { provider: "anthropic" as const, model: "claude-sonnet-4-6", apiMode: "anthropic_messages" as const,
      baseUrl: "https://api.anthropic.com" as const, env: { ANTHROPIC_API_KEY: "synthetic" } };
  });
  const funded = vi.fn(async () => mode !== "unfunded");
  const read = vi.fn(async (_owner: string, _scope: HermesJevScope, action: string) => {
    if (action === "get_profile") return { emailAddress: "me@example.test" };
    return { threads: [] };
  });
  const evaluate = vi.fn();
  const runtime = createJevInboxRuntime({ ownerId: owner, getAgent, resolveCredentials: credentials,
    verifyRuntime: vi.fn(async () => undefined), fundedPolicyReady: vi.fn(async () => mode !== "unfunded"), fundedReady: funded, read, evaluate });
  return { runtime, getAgent, credentials, funded, read, evaluate };
}
it("admission validates selected source and funding without mailbox reads or inference", async () => {
  const f = fixture(); await f.runtime.admit(owner, agent);
  expect(f.credentials).toHaveBeenCalledWith(owner, agent.selection, expect.any(AbortSignal));
  expect(f.funded).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled(); expect(f.evaluate).not.toHaveBeenCalled();
});
it("matches profile before paid probe and denies preview while the probe is provisional", async () => {
  const f = fixture(); let resolve!: (value: boolean) => void;
  let profileActionsAtProbe: string[] = [];
  const waiting = new Promise<boolean>(done => { resolve = done; });
  f.funded.mockImplementationOnce(async () => {
    profileActionsAtProbe = f.read.mock.calls.map(call => call[2]);
    return waiting;
  });
  const controller = new AbortController();
  const preflight = f.runtime.launch.preflight(owner, scope, controller.signal).then(() => null, error => error);
  await vi.waitFor(() => expect(f.funded).toHaveBeenCalledOnce());
  expect(profileActionsAtProbe).toEqual(["get_profile"]);
  await expect(f.runtime.broker.execute(owner, scope, { operation: "discover" })).rejects.toThrow();
  expect(f.read.mock.calls.every(call => call[2] === "get_profile")).toBe(true);
  controller.abort(); resolve(true);
  expect(await preflight).toBeInstanceOf(Error);
  await expect(f.runtime.broker.execute(owner, scope, { operation: "discover" })).rejects.toThrow();
});
it("rejects mismatched live profile with zero paid probes", async () => {
  const f = fixture(); f.read.mockResolvedValueOnce({ emailAddress: "other@example.test" });
  await expect(f.runtime.launch.preflight(owner, scope, new AbortController().signal)).rejects.toThrow();
  expect(f.funded).not.toHaveBeenCalled(); expect(f.evaluate).not.toHaveBeenCalled();
});
it.each(["unsupported", "unfunded", "missing", "stale"])("denies %s before primary run preflight", async mode => {
  const f = fixture(mode); await expect(f.runtime.admit(owner, agent)).rejects.toThrow();
  expect(f.read).not.toHaveBeenCalled(); expect(f.evaluate).not.toHaveBeenCalled();
});
it("requires active preflight and server binding, and stops on cancellation", async () => {
  const f = fixture(); const controller = new AbortController();
  await expect(f.runtime.broker.execute(owner, scope, { operation: "discover" })).rejects.toThrow();
  await f.runtime.launch.preflight(owner, scope, controller.signal);
  expect(f.read.mock.calls.map(call => call[2])).toEqual(["get_profile"]);
  await expect(f.runtime.broker.execute(owner, { ...scope, account: { ...scope.account, connectionId: "foreign" } }, { operation: "discover" })).rejects.toThrow();
  controller.abort();
  await expect(f.runtime.broker.execute(owner, scope, { operation: "discover" })).rejects.toThrow();
  expect(f.evaluate).not.toHaveBeenCalled();
});
it("revocation blocks later calls while ordinary owner cannot use another run", async () => {
  const f = fixture(); await f.runtime.launch.preflight(owner, scope, new AbortController().signal);
  await expect(f.runtime.broker.execute("wrong_owner", scope, { operation: "discover" })).rejects.toThrow();
  f.runtime.launch.clearRun(owner, scope.runId);
  await expect(f.runtime.broker.execute(owner, scope, { operation: "discover" })).rejects.toThrow();
});
