import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { createRoutineCliActionController } from "../../../packages/gateway/src/bots/routine-action-controller.js";
import { createRoutineActionSourceRegistry, type RoutineSourcePolicy } from "../../../packages/gateway/src/bots/routine-action-source-registry.js";
import { createRoutineActionPlatformClient } from "../../../packages/gateway/src/bots/routine-action-platform-client.js";
import { createRoutineActionVerificationRoutes } from "../../../packages/platform/src/routine-action-routes.js";
import { authenticatedApprovalProxyProof } from "../../../packages/platform/src/canonical-owner-approval-proxy.js";
import { buildPlatformVerificationToken } from "../../../packages/platform/src/platform-token.js";
import { requestFixture, propose, scope } from "./routine-cli-request-support.js";
import { context, invocation } from "./routine-cli-source-support.js";
import { createRoutineCliRequestService } from "../../../packages/gateway/src/bots/routine-cli-requests.js";
import { createRealBotStateDatabase } from "./bot-state-support.js";
import type { RoutineActionView } from "@matrix-os/contracts";

const secret = "fixture-platform-only-routine-proof", handle = scope.computerId.toLowerCase().replaceAll("_", "-");
const machine = { machineId: "machine_one", handle, runtimeSlot: "primary", clerkUserId: scope.ownerId, provisioningClass: "customer" as const };
const identity = { handle, runtimeSlot: "primary", userId: scope.ownerId, source: "auth" as const,
  sessionProvenance: "clerk-browser" as const, sessionExpiresAt: Math.floor(Date.now() / 1000) + 600 };
const waitFor = async (read: () => boolean) => { for (let i = 0; i < 100 && !read(); i++) await new Promise(resolve => setTimeout(resolve, 5)); expect(read()).toBe(true); };
let db: Kysely<OwnerBotDatabase>, closeDb: () => Promise<void>, f: Awaited<ReturnType<typeof requestFixture>>;
let controller: ReturnType<typeof createRoutineCliActionController>, registry: ReturnType<typeof createRoutineActionSourceRegistry>;
let clock: number, offset: number, network: { calls: number; wait?: Promise<void> };
let policy: RoutineSourcePolicy, sourceAbort: AbortController, emitted: RoutineActionView[];
async function setup(kind: "chat_run" | "terminal_launch" = "chat_run") {
  const source = { ...context("task4b_generation"), issuedAt: new Date(clock).toISOString(), expiresAt: new Date(clock + 240_000).toISOString(),
    ...(kind === "terminal_launch" ? { identity: { kind, sessionId: "terminal_real", incarnationId: "inc_one", launchId: "launch_real" } } : {}) };
  return controller.register({ source, readPolicy: () => policy, signal: sourceAbort.signal, validateWithin: async () => true,
    publish: () => { emitted = controller.list({ userId: scope.ownerId, source: "jwt" }, true); } });
}
async function answer(view: RoutineActionView, decision: "approve" | "decline" | "cancel" = "approve", n = 900) {
  const body = { actionDigest: view.actionDigest, decision, clientRequestId: invocation(n) };
  const path = `/api/routine-cli/actions/${view.challengeId}/decision`;
  const proof = await authenticatedApprovalProxyProof({ request: new Request(`https://app.example.test${path}`, { method: "POST", body: JSON.stringify(body) }),
    method: "POST", path, handle, identity, machine, platformSecret: secret });
  expect(proof).toEqual(expect.any(String));
  return controller.submit({ userId: scope.ownerId, source: "jwt" }, view.challengeId, body, proof as string);
}
beforeEach(async () => {
  const url = process.env.MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL;
  if (!url) throw new Error("MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL is required for exact routine action authority");
  const fixture = await createRealBotStateDatabase(url); db = fixture.db; closeDb = fixture.destroy;
  f = await requestFixture(db); clock = Date.now(); offset = 0; network = { calls: 0 }; policy = { live: true, scope: "personal", interactionMode: "default", permissionMode: "supervised", originCeiling: "exact", revision: "p1" };
  sourceAbort = new AbortController(); emitted = []; registry = createRoutineActionSourceRegistry({ now: () => Date.now() + offset });
  const platform = createRoutineActionVerificationRoutes({ platformSecret: secret,
    lookup: { resolveMachine: async () => ({ ...machine, status: "running" }) } });
  const client = createRoutineActionPlatformClient({ platformUrl: "https://platform.example.test", handle, token: buildPlatformVerificationToken(handle, secret),
    fetcher: async (url, init) => { network.calls++; await network.wait; return platform.request(new Request(url, init)); } });
  controller = createRoutineCliActionController({ db, scope, agents: f.agents, registry,
    platform: { handle, runtimeSlot: "primary", machineId: machine.machineId, verify: client.verify }, now: () => Date.now() + offset, canAccessTarget: async () => true });
});
afterEach(async () => { controller?.close(); registry?.close(); await f?.close(); await closeDb?.(); });
describe("routine action real Platform producer -> gateway controller -> durable source consumption", () => {
  it("waits without DB locks, signs one exact invocation and preserves consumed queued decision after normal CLI exit", async () => {
    const source = await setup(), operation = propose(100), id = invocation(1);
    const prepared = source.authorize({ operation, invocationId: id, signal: new AbortController().signal });
    await waitFor(() => emitted.length === 1);
    await answer(emitted[0]!); expect(await prepared).toBe(true);
    const delivery = await source.issue({ operation, invocationId: id, signal: new AbortController().signal });
    const service = createRoutineCliRequestService({ db, scope, sources: controller.sources, targets: controller.targets,
      transact: f.transact, authorizeTarget: controller.authorizeTarget, admitMutation: f.admitMutation });
    const result = await service.execute({ token: delivery.takeToken(), operation }); expect(result.kind).toBe("receipt");
    const accepted = await db.selectFrom("routine_cli_capabilities").select("operation_digest").where("invocation_id", "=", id).executeTakeFirstOrThrow();
    await source.cancel({ operation, invocationId: id, reason: "finished" });
    await db.transaction().execute(trx => controller.sources.validateAcceptedWithin(trx, {
      source: source.source, operation, invocation: { sourceId: source.reference.sourceId, invocationId: id, operationDigest: accepted.operation_digest },
    }, async () => true));
    sourceAbort.abort();
    await expect(db.transaction().execute(trx => controller.sources.validateAcceptedWithin(trx, {
      source: source.source, operation, invocation: { sourceId: source.reference.sourceId, invocationId: id, operationDigest: accepted.operation_digest },
    }, async () => true))).rejects.toMatchObject({ code: "permission_denied" });
  });
  it("revocation and default changes can proceed while waiting and win before issuance", async () => {
    const source = await setup(), operation = propose(101);
    const preparing = source.authorize({ operation, invocationId: invocation(2), signal: new AbortController().signal });
    await waitFor(() => emitted.length === 1); await f.switchDefault();
    await expect(answer(emitted[0]!)).rejects.toMatchObject({ code: "revision_conflict" });
    sourceAbort.abort(); expect(await preparing).toBe(false);
  });
  it("Terminal uses its real distinct launch and requires exact decision even with full access", async () => {
    policy.permissionMode = "full_access"; policy.originCeiling = "full";
    const source = await setup("terminal_launch"), operation = propose(102);
    const preparing = source.authorize({ operation, invocationId: invocation(3), signal: new AbortController().signal });
    await waitFor(() => controller.list({ userId: scope.ownerId, source: "jwt" }).length === 1);
    const view = controller.list({ userId: scope.ownerId, source: "jwt" })[0]!;
    expect(view.sourceKind).toBe("terminal_launch"); await answer(view); expect(await preparing).toBe(true);
    expect(emitted).toEqual([]);
  });
});

it("keeps concurrent identical operations separate by host invocation, never the latest digest", async () => {
  const source = await setup(), operation = propose(111), signal = new AbortController().signal;
  const first = source.authorize({ operation, invocationId: invocation(11), signal });
  const second = source.authorize({ operation, invocationId: invocation(12), signal });
  await waitFor(() => emitted.length === 2);
  const views = controller.list({ userId: scope.ownerId, source: "jwt" }, true);
  expect(views[0]!.actionDigest).not.toBe(views[1]!.actionDigest);
  await answer(views[0]!); expect(await first).toBe(true);
  await expect(source.issue({ operation, invocationId: invocation(12), signal })).rejects.toMatchObject({ code: "permission_denied" });
  await answer(views[1]!, "decline", 912); expect(await second).toBe(false);
  await expect(source.issue({ operation: propose(112), invocationId: invocation(11), signal })).rejects.toMatchObject({ code: "permission_denied" });
});
it("duplicates exactly one decision request but rejects changed request, wrong owner/digest and no proof", async () => {
  const source = await setup(), operation = propose(113), signal = new AbortController().signal;
  const pending = source.authorize({ operation, invocationId: invocation(13), signal });
  await waitFor(() => emitted.length === 1); const view = emitted[0]!;
  expect(() => controller.get({ userId: "user_foreign", source: "jwt" }, view.challengeId)).toThrow();
  await expect(controller.submit({ userId: scope.ownerId, source: "jwt" }, view.challengeId,
    { actionDigest: "f".repeat(64), decision: "approve", clientRequestId: invocation(913) }, "untrusted")).rejects.toMatchObject({ code: "permission_denied" });
  await expect(controller.submit({ userId: scope.ownerId, source: "jwt" }, view.challengeId,
    { actionDigest: view.actionDigest, decision: "approve", clientRequestId: invocation(913) }, "")).rejects.toMatchObject({ code: "permission_denied" });
  expect(network.calls).toBe(0);
  expect(await answer(view, "approve", 913)).toEqual({ submission: "accepted" });
  expect(await answer(view, "approve", 913)).toEqual({ submission: "already_submitted" });
  await expect(answer(view, "approve", 914)).rejects.toMatchObject({ code: "revision_conflict" });
  expect(await pending).toBe(true);
});
it.each(["policy", "source", "timeout", "cancel"] as const)("%s wins a pending owner wait and cannot deliver a late capability", async reason => {
  const source = await setup(), operation = propose(114), abort = new AbortController();
  const pending = source.authorize({ operation, invocationId: invocation(14), signal: abort.signal });
  await waitFor(() => emitted.length === 1); const view = emitted[0]!;
  if (reason === "policy") policy.revision = "changed";
  if (reason === "source") sourceAbort.abort();
  if (reason === "timeout") offset += 120_001;
  if (reason === "cancel") await source.cancel({ invocationId: invocation(14), reason: "aborted" });
  controller.list({ userId: scope.ownerId, source: "jwt" }, true);
  expect(await pending).toBe(false);
  await expect(answer(view)).rejects.toBeDefined();
  await expect(source.issue({ operation, invocationId: invocation(14), signal: abort.signal })).rejects.toMatchObject({ code: "permission_denied" });
});
it("remote proof wait holds no source or preference transaction, and post-await local state wins", async () => {
  const source = await setup(), operation = propose(115), signal = new AbortController().signal;
  const pending = source.authorize({ operation, invocationId: invocation(15), signal });
  await waitFor(() => emitted.length === 1); let release!: () => void; network.wait = new Promise<void>(resolve => { release = resolve; });
  const deciding = answer(emitted[0]!); void deciding.catch(() => undefined);
  try {
    await waitFor(() => network.calls === 1);
    await f.switchDefault(); // Must complete before releasing Platform response: no held preference/source/DB lock.
    await source.revoke(); // Real serialized DB revoke also completes while network is pending.
    release(); await expect(deciding).rejects.toMatchObject({ code: "permission_denied" }); expect(await pending).toBe(false);
  } finally { release(); await Promise.allSettled([deciding, pending]); }
});
it("fresh full-access policy permits strict operations without a card but plan/review ceilings deny", async () => {
  policy.permissionMode = "full_access"; policy.originCeiling = "full";
  const source = await setup(), operation = propose(116), signal = new AbortController().signal;
  expect(await source.authorize({ operation, invocationId: invocation(16), signal })).toBe(true);
  expect(controller.list({ userId: scope.ownerId, source: "jwt" }, true)).toEqual([]); expect(network.calls).toBe(0);
  for (const interactionMode of ["plan", "review"] as const) {
    policy.interactionMode = interactionMode;
    await expect(source.authorize({ operation, invocationId: invocation(interactionMode === "plan" ? 17 : 18), signal })).rejects.toMatchObject({ code: "permission_denied" });
  }
});
it("target changes after issue roll consumption back; duplicate original UUID remains pinned to its original target", async () => {
  const source = await setup(), operation = propose(119), signal = new AbortController().signal;
  const pending = source.authorize({ operation, invocationId: invocation(19), signal }); await waitFor(() => emitted.length === 1); await answer(emitted[0]!); await pending;
  const token = (await source.issue({ operation, invocationId: invocation(19), signal })).takeToken(); await f.switchDefault();
  const service = createRoutineCliRequestService({ db, scope, sources: controller.sources, targets: controller.targets,
    transact: f.transact, authorizeTarget: controller.authorizeTarget, admitMutation: f.admitMutation });
  await expect(service.execute({ token, operation })).rejects.toMatchObject({ code: "permission_denied" });
  expect(await db.selectFrom("routine_cli_requests").selectAll().execute()).toEqual([]);
  expect((await db.selectFrom("routine_cli_capabilities").select("consumed_at").where("invocation_id", "=", invocation(19)).executeTakeFirstOrThrow()).consumed_at).toBeNull();
});
it("publication failure discards the reserved local challenge without issuing authority", async () => {
  const source = await controller.register({ source: { ...context("publish_failure"), issuedAt: new Date(clock).toISOString(), expiresAt: new Date(clock + 240_000).toISOString() },
    readPolicy: () => policy, signal: sourceAbort.signal, validateWithin: async () => true, publish: () => { throw new Error("Fixture publisher unavailable"); } });
  await expect(source.authorize({ operation: propose(120), invocationId: invocation(20), signal: new AbortController().signal })).rejects.toThrow("Fixture publisher unavailable");
  expect(controller.list({ userId: scope.ownerId, source: "jwt" }, true)).toEqual([]);
  expect(await db.selectFrom("routine_cli_capabilities").selectAll().execute()).toEqual([]);
});
it("a fresh duplicate decision reconciles the original UUID and target after the default changed, without readmission", async () => {
  const source = await setup(), operation = propose(121), signal = new AbortController().signal;
  const service = createRoutineCliRequestService({ db, scope, sources: controller.sources, targets: controller.targets,
    transact: f.transact, authorizeTarget: controller.authorizeTarget, admitMutation: f.admitMutation });
  for (const n of [21, 22]) {
    const waiting = source.authorize({ operation, invocationId: invocation(n), signal });
    await waitFor(() => controller.list(f.principal, true).length === n - 20);
    const view = controller.list(f.principal, true).find(item => item.status === "pending")!;
    expect(view.target.chatId).toBe("chat_target_a"); await answer(view, "approve", 900 + n); expect(await waiting).toBe(true);
    const token = (await source.issue({ operation, invocationId: invocation(n), signal })).takeToken();
    expect(await service.execute({ token, operation })).toMatchObject({ receipt: { requestId: invocation(121), disposition: "queued" } });
    await source.cancel({ invocationId: invocation(n), reason: "finished" });
    if (n === 21) await f.switchDefault();
  }
  expect(await db.selectFrom("bot_tasks").selectAll().execute()).toHaveLength(1);
  expect(await db.selectFrom("routine_cli_requests").selectAll().execute()).toHaveLength(1);
});
it("source revocation after the issuance target check rolls capability creation back before commit", async () => {
  const { createRoutineCliSourceService } = await import("../../../packages/gateway/src/bots/routine-cli-source.js");
  const abort = new AbortController();
  const sources = createRoutineCliSourceService({ db, scope, validateLifecycle: async () => !abort.signal.aborted,
    authorizeOperation: async () => true, authorizeIssueTarget: async () => { abort.abort(); return true; } });
  const source = await sources.register({ ...context("issue_commit_race"), issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 240_000).toISOString() });
  await expect(sources.issue(source, { operation: { operation: "list" }, invocationId: invocation(90) })).rejects.toMatchObject({ code: "permission_denied" });
  expect(await db.selectFrom("routine_cli_capabilities").selectAll().where("source_id", "=", source.sourceId).execute()).toEqual([]);
});
