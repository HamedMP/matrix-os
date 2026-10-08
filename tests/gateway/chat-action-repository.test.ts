import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { ActionRepository } from "../../packages/gateway/src/chat/action-repository.js";
import { createCanonicalActionAuthority } from "../../packages/gateway/src/chat/action-authority.js";
import type { CanonicalActionTool } from "../../packages/gateway/src/chat/action-tools.js";
import { normalizedArgumentDigest } from "../../packages/gateway/src/chat/argument-digest.js";
const owner = { type: "personal" as const, ownerId: "owner_actions" };
const policy = { revision: "actions_v1", actionMode: "canonical_actions" as const, workspaceScope: "apps", tools: ["matrix_apply_app_files"], delegation: false };
let chat: ChatRepository;
let actions: ActionRepository;
beforeEach(async () => {
  const pg = await KyselyPGlite.create(); chat = new ChatRepository(pg.dialect); await chat.bootstrap();
  await chat.create(owner, { id: "chat_actions", clientRequestId: "req_create_actions", title: "Actions" });
  // Real canonical rows, no authority test bypass.
  await chat.kysely.insertInto("chat_messages").values({ id: "msg_actions", chat_id: "chat_actions", seq: 1, role: "user", purpose: "ai_request", state: "committed", turn_id: null, run_id: null, actor_id: owner.ownerId, parts: [{ type: "text", text: "apply" }], byte_count: 5, search_text: "apply", created_at: new Date() }).execute();
  await chat.kysely.insertInto("chat_turns").values({ id: "cturn_actions", chat_id: "chat_actions", client_request_id: "turn_actions", base_message_seq: 0, input_message_id: "msg_actions", status: "running", created_at: new Date(), updated_at: new Date() }).execute();
  await chat.kysely.insertInto("chat_runs").values({ id: "run_actions", chat_id: "chat_actions", turn_id: "cturn_actions", client_request_id: "run_actions", attempt: 1, driver_kind: "codex", instance_id: "codex_default", selection: { instanceId: "codex_default", model: "fake_model" }, interaction_mode: "default", permission_mode: "supervised", execution_root: null, execution_root_fingerprint: null, status: "running", outcome: null, history_boundary_seq: 0, capability_snapshot: {}, run_policy: { memoryMode: "ordinary", source: "typed", nativeCheckpointPolicy: "reusable", executionPolicy: policy }, created_at: new Date(), updated_at: new Date() }).execute();
  actions = new ActionRepository(chat.kysely);
});
afterEach(async () => { await chat.kysely.destroy(); });
const proposal = () => ({ id: "action_test", owner, chatId: "chat_actions", runId: "run_actions", workspaceScope: "apps", policyRevision: policy.revision, executionPolicy: policy, toolId: "matrix_apply_app_files", schemaRevision: "files_v1", arguments: { app: "notes" }, argumentDigest: normalizedArgumentDigest({ app: "notes" }), state: "waiting_for_approval" as const, revision: 0, cancellationRequested: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
const identity = { owner, chatId: "chat_actions", runId: "run_actions", actionId: "action_test" };
const invocation = () => ({ ...identity, toolId: policy.tools[0]!, arguments: { app: "notes" }, executionPolicy: policy, signal: new AbortController().signal });
function authorityFor(execute: CanonicalActionTool["execute"], confirmed: () => boolean = () => false, timeoutMs = 1_000) {
  return createCanonicalActionAuthority({ repository: actions, qualifyPolicy: async () => policy, timeoutMs,
    tools: [{ toolId: policy.tools[0]!, schemaRevision: "files_v1", description: "fake bounded commit port", inputSchema: {}, effect: "files", approval: true, reconciliation: true, cancellation: "before_dispatch", normalize: (args) => args, execute, reconcile: async () => ({ confirmed: confirmed(), result: { committed: true } }) }],
    onEvent: async (input, event) => { if (event.type === "approval.requested") await actions.decide({ ...input, argumentDigest: event.argumentDigest!, decision: "approve", clientRequestId: "req_fake_approve" }); },
  });
}
describe("canonical effect lifecycle", () => {
  it("persists proposal before effect and never replays a committed but unresolved outcome", async () => {
    let effects = 0; let committed = false;
    const authority = authorityFor(async () => {
      expect((await actions.get(identity)).state).toBe("running");
      effects++; committed = true; // real potential effect occurred before result persistence fails
      throw new Error("simulated crash after downstream commit");
    }, () => committed);
    await expect(authority.invoke(invocation())).rejects.toThrow();
    expect((await actions.get(identity)).state).toBe("outcome_unknown");
    await expect(authority.invoke(invocation())).rejects.toThrow();
    expect(effects).toBe(1);
    expect(await authority.reconcilePending()).toEqual({ checked: 1, resolved: 1, uncertain: 0 });
    expect((await actions.get(identity)).state).toBe("succeeded");
    expect(await authority.invoke(invocation())).toEqual({ committed: true });
    expect(effects).toBe(1);
  });
  it("keeps a committed effect unknown if result persistence fails, without redispatch", async () => {
    let effects = 0;
    const authority = authorityFor(async () => { effects++; return { committed: true }; });
    vi.spyOn(actions, "transition").mockRejectedValueOnce(new Error("simulated result persistence failure"));
    await expect(authority.invoke(invocation())).rejects.toThrow();
    expect(effects).toBe(1); expect((await actions.get(identity)).state).toBe("outcome_unknown");
    await expect(authority.invoke(invocation())).rejects.toThrow(); expect(effects).toBe(1);
  });
  it("records ambiguous timeout when the downstream may already have committed", async () => {
    let committed = false;
    const authority = authorityFor(async () => { committed = true; await new Promise((resolve) => setTimeout(resolve, 80)); return { committed }; }, () => committed, 20);
    await expect(authority.invoke(invocation())).rejects.toThrow();
    expect((await actions.get(identity)).state).toBe("outcome_unknown");
    expect(committed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect((await actions.get(identity)).state).toBe("outcome_unknown");
  });
  it("does not claim a running effect cancelled until the effect confirms its outcome", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
    const authority = authorityFor(async () => { entered(); await gate; return { committed: true }; });
    const running = authority.invoke(invocation());
    const outcome = running.then((value) => ({ value }), (error: unknown) => ({ error }));
    await started;
    const cancelled = await authority.cancelById({ owner, chatId: identity.chatId, actionId: identity.actionId });
    expect(cancelled.state).toBe("running"); expect(cancelled.cancellationRequested).toBe(true);
    release(); expect(await outcome).toEqual({ value: { committed: true } });
    expect((await actions.get(identity)).state).toBe("succeeded");
    expect((await actions.get(identity)).cancellationRequested).toBe(true);
  });
  it("retries a CAS-lost cancellation and lands the flag on a re-read row", async () => {
    const op = await actions.propose(proposal());
    const authority = authorityFor(async () => ({ committed: true }));
    // First write loses the race — the loop must re-read and retry rather
    // than return a row that never recorded the request.
    const tryTransition = vi.spyOn(actions, "tryTransition").mockResolvedValueOnce(null);
    const cancelled = await authority.cancelById({ owner, chatId: op.chatId, actionId: op.id });
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.cancellationRequested).toBe(true);
    expect(tryTransition).toHaveBeenCalledTimes(2);
  });
  it("emits one cancelled activity for the request that landed the transition", async () => {
    await actions.propose(proposal());
    const progress: string[] = [];
    const authority = createCanonicalActionAuthority({
      repository: actions, qualifyPolicy: async () => policy, timeoutMs: 1_000,
      tools: [{ toolId: policy.tools[0]!, schemaRevision: "files_v1", description: "fake bounded commit port", inputSchema: {}, effect: "files", approval: true, reconciliation: true, cancellation: "before_dispatch", normalize: (args) => args, execute: async () => ({ committed: true }), reconcile: async () => ({ confirmed: true }) }],
      onEvent: async (_input, event) => { if (event.type === "tool.progress" && event.status === "cancelled") progress.push(event.toolCallId); },
    });
    const first = await authority.cancelById({ owner, chatId: identity.chatId, actionId: identity.actionId });
    const second = await authority.cancelById({ owner, chatId: identity.chatId, actionId: identity.actionId });
    expect(first.state).toBe("cancelled");
    expect(second.state).toBe("cancelled");
    expect(progress).toEqual([identity.actionId]);
  });
  it("returns an already-flagged in-flight operation without another write", async () => {
    const op = await actions.propose(proposal());
    const authorized = await actions.decide({ owner, chatId: op.chatId, runId: op.runId, actionId: op.id, argumentDigest: op.argumentDigest, decision: "approve", clientRequestId: "req_approve_flagged" });
    const claimed = await actions.claim(authorized);
    expect(claimed).not.toBeNull();
    const authority = authorityFor(async () => ({ committed: true }));
    const first = await authority.cancelById({ owner, chatId: op.chatId, actionId: op.id });
    expect(first.state).toBe("running");
    expect(first.cancellationRequested).toBe(true);
    const second = await authority.cancelById({ owner, chatId: op.chatId, actionId: op.id });
    expect(second).toEqual(first);
  });
});
describe("durable canonical action identity and claim", () => {
  it("rejects owner mismatch and changed arguments on the same identity", async () => {
    await expect(actions.propose({ ...proposal(), owner: { ...owner, ownerId: "other" } })).rejects.toThrow();
    await actions.propose(proposal());
    await expect(actions.propose({ ...proposal(), arguments: { app: "other" }, argumentDigest: normalizedArgumentDigest({ app: "other" }) })).rejects.toThrow();
  });
  it("consumes authorization once with a revision/state write predicate", async () => {
    const op = await actions.propose(proposal());
    const authorized = await actions.decide({ owner, chatId: op.chatId, runId: op.runId, actionId: op.id, argumentDigest: op.argumentDigest, decision: "approve", clientRequestId: "req_approve_once" });
    const claims = await Promise.all([actions.claim(authorized), actions.claim(authorized)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await actions.get({ owner, chatId: op.chatId, runId: op.runId, actionId: op.id })).state).toBe("running");
  });
  it("binds policy, normalized args and schema on replay", async () => {
    await actions.propose(proposal());
    await expect(actions.propose({ ...proposal(), schemaRevision: "files_v2" })).rejects.toThrow();
    await chat.kysely.updateTable("chat_runs").set({ run_policy: { memoryMode: "ordinary", source: "typed", nativeCheckpointPolicy: "reusable", executionPolicy: { ...policy, workspaceScope: "elsewhere" } } }).where("id", "=", "run_actions").execute();
    await expect(actions.decide({ owner, chatId: "chat_actions", runId: "run_actions", actionId: "action_test", argumentDigest: proposal().argumentDigest, decision: "approve", clientRequestId: "req_approve_drift" })).rejects.toThrow();
  });
});
