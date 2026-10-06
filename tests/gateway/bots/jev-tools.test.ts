import { describe, expect, it, vi } from "vitest";
import { createBotJevTools } from "../../../packages/gateway/src/bots/jev-tools.js";
import type { BotRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import type { BotGrantRecord } from "../../../packages/gateway/src/bots/repositories/grants.js";

const binding = { ownerId: "owner", botId: "bot_jevtest123", runId: "run_jev", capabilities: ["jev.inbox"] } as unknown as BotRuntimeBinding;
const grant: BotGrantRecord = { grantId: "gr_jevtest", ownerId: "owner", botId: binding.botId, service: "gmail",
  connectionId: "connection", accountLabel: "Work", effects: ["read", "label"], audience: "direct", grantedByActorId: "owner",
  revision: 1, createdAt: new Date().toISOString(), expiresAt: null, revokedAt: null };
function setup() {
  const run = new AbortController();
  const state = { grants: [structuredClone(grant)], revision: 2, recipeId: "jev-inbox-triage", email: "owner@example.com" };
  const read = vi.fn(async (_owner, _scope, action) => action === "get_profile" ? { emailAddress: state.email } : { threads: [] });
  const evaluate = vi.fn();
  const fundedReady = vi.fn(async () => true);
  const tools = createBotJevTools({ agents: { get: vi.fn(async () => ({ id: binding.botId, revision: state.revision, recipeRef: { recipeId: state.recipeId, version: "1" } }) as never) },
    listGrants: async () => state.grants,
    signalFor: () => run.signal,
    recipes: { resolve: () => ({ capabilities: ["jev.inbox"], integrations: [{ service: "gmail", effects: ["read", "label"] }] }) } as never,
    workflow: { read, evaluate, fundedReady, listGmailAccounts: async () => [
      { id: "connection", service: "gmail", account_label: "Work", account_email: state.email, status: "active" } ] },
  });
  return { tools, state, read, evaluate, run, fundedReady };
}
describe("Pi Bot Jev authority", () => {
  it("does not dispatch a parallel request before admission funding has completed", async () => {
    const { tools, fundedReady, read } = setup();
    let settle!: (ready: boolean) => void;
    fundedReady.mockImplementation(() => new Promise(resolve => { settle = resolve; }));
    const first = expect(tools.call(binding, { operation: "discover" }, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: "unavailable" });
    await vi.waitFor(() => expect(fundedReady).toHaveBeenCalledOnce());
    await expect(tools.call(binding, { operation: "discover" }, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: "unavailable" });
    expect(read.mock.calls.every(call => call[2] === "get_profile")).toBe(true);
    settle(false);
    await first;
    await tools.close();
    await expect(tools.call(binding, { operation: "discover" }, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: "unavailable" });
  });

  it("uses the server-granted account and returns actual broker discovery", async () => {
    const { tools, read, evaluate } = setup();
    const result = await tools.call(binding, { operation: "discover" }, AbortSignal.timeout(1000));
    expect(JSON.parse(result.content[0]!.text!)).toMatchObject({ kind: "discovery", threads: [], readonly: true });
    expect(read.mock.calls[0]?.[1]).toMatchObject({ agentId: binding.botId, account: { expectedEmail: "owner@example.com", labelingEnabled: true } });
    expect(evaluate).not.toHaveBeenCalled();
  });
  it.each(["missing", "read_only", "wrong_account", "expired", "revoked", "ambiguous", "wrong_recipe", "wrong_owner"])("denies %s authority before reading mail", async reason => {
    const { tools, state, read } = setup();
    if (reason === "missing") state.grants = [];
    if (reason === "read_only") state.grants[0]!.effects = ["read"];
    if (reason === "wrong_account") state.grants[0]!.connectionId = "other";
    if (reason === "expired") state.grants[0]!.expiresAt = "2020-01-01T00:00:00Z";
    if (reason === "revoked") state.grants[0]!.revokedAt = new Date().toISOString();
    if (reason === "ambiguous") state.grants.push({ ...grant, grantId: "gr_other" });
    if (reason === "wrong_recipe") state.recipeId = "other";
    if (reason === "wrong_owner") state.grants[0]!.ownerId = "other";
    await expect(tools.call(binding, { operation: "discover" }, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: "not_granted" });
    expect(read).not.toHaveBeenCalled();
  });
  it("revocation or changed grant revision takes effect on the next checkpoint", async () => {
    const { tools, state, read } = setup();
    await tools.call(binding, { operation: "discover" }, AbortSignal.timeout(1000));
    const before = read.mock.calls.length;
    state.grants[0]!.revision++;
    await expect(tools.call(binding, { operation: "discover" }, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: "not_granted" });
    expect(read).toHaveBeenCalledTimes(before);
  });
  it("refuses a stale Bot revision and a cancelled runtime", async () => {
    const { tools, state, run } = setup();
    await tools.call(binding, { operation: "discover" }, AbortSignal.timeout(1000));
    state.revision++;
    await expect(tools.call(binding, { operation: "discover" }, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: "not_granted" });
    run.abort();
    await expect(tools.call(binding, { operation: "discover" }, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: "stale_generation" });
  });
});
