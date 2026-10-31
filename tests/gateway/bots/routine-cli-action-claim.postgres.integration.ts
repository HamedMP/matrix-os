import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRealBotStateDatabase } from "./bot-state-support.js";
import { proposalFixture } from "./routine-cli-proposal-support.js";
import { createRoutineCliActionController } from "../../../packages/gateway/src/bots/routine-action-controller.js";
import { createRoutineActionSourceRegistry } from "../../../packages/gateway/src/bots/routine-action-source-registry.js";
import { createRoutineActionPlatformClient } from "../../../packages/gateway/src/bots/routine-action-platform-client.js";
import { createRoutineActionVerificationRoutes } from "../../../packages/platform/src/routine-action-routes.js";
import { authenticatedApprovalProxyProof } from "../../../packages/platform/src/canonical-owner-approval-proxy.js";
import { buildPlatformVerificationToken } from "../../../packages/platform/src/platform-token.js";
import { context, invocation } from "./routine-cli-source-support.js";
import { propose, scope } from "./routine-cli-request-support.js";
import type { RoutineCliAfterMutationCommit } from "../../../packages/gateway/src/bots/routine-cli-requests.js";
let data: Awaited<ReturnType<typeof createRealBotStateDatabase>>, f: Awaited<ReturnType<typeof proposalFixture>>;
let controller: ReturnType<typeof createRoutineCliActionController>, registry: ReturnType<typeof createRoutineActionSourceRegistry>, offset: number;
const secret = "fixture-platform-exact-owner-consent", handle = "computer-one", machineId = "fixture-machine";
const machine = { machineId, handle, runtimeSlot: "primary", clerkUserId: scope.ownerId, provisioningClass: "customer" as const };
beforeEach(async () => {
  const url = process.env.MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL; if (!url) throw new Error("MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL is required");
  data = await createRealBotStateDatabase(url); f = await proposalFixture(data.db, vi.fn); offset = 0;
  registry = createRoutineActionSourceRegistry({ now: () => Date.now() + offset });
  const platform = createRoutineActionVerificationRoutes({ platformSecret: secret, lookup: { resolveMachine: async () => ({ ...machine, status: "running" }) } });
  const client = createRoutineActionPlatformClient({ platformUrl: "https://platform.example.test", handle,
    token: buildPlatformVerificationToken(handle, secret), fetcher: async (url, init) => platform.request(new Request(url, init)) });
  controller = createRoutineCliActionController({ db: data.db, scope, agents: f.agents, registry, now: () => Date.now() + offset,
    platform: { handle, machineId, runtimeSlot: "primary", verify: client.verify }, canAccessTarget: async () => true });
  f.hooks.sources = controller.sources; f.hooks.targets = controller.targets; f.hooks.authorizeTarget = controller.authorizeTarget;
});
afterEach(async () => { controller?.close(); registry?.close(); await f?.close(); await data?.destroy(); });
it.each(["live", "source-ended", "decision-expired", "source-ended-after-claim"] as const)("normal queued CLI exit retains only consumed exact decision before real canonical claim: %s", async state => {
  const abort = new AbortController(), operation = propose(), id = invocation(700);
  const source = await controller.register({ source: { ...context("owner_decision_claim"), issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 240_000).toISOString() },
    signal: abort.signal, readPolicy: () => ({ live: true, scope: "personal", permissionMode: "supervised", interactionMode: "default", originCeiling: "exact", revision: "policy_1" }),
    validateWithin: async () => true, publish: () => {} });
  const signal = new AbortController().signal, authorizing = source.authorize({ operation, invocationId: id, signal });
  let view: ReturnType<typeof controller.list>[number] | undefined;
  for (let i = 0; i < 100 && !view; i++) { view = controller.list(f.principal, true)[0]; if (!view) await new Promise(resolve => setTimeout(resolve, 5)); }
  expect(view).toBeDefined(); const body = { actionDigest: view!.actionDigest, decision: "approve" as const, clientRequestId: invocation(701) };
  const path = `/api/routine-cli/actions/${view!.challengeId}/decision`;
  const proof = await authenticatedApprovalProxyProof({ request: new Request(`https://app.example.test${path}`, { method: "POST", body: JSON.stringify(body) }), method: "POST", path,
    handle, machine, platformSecret: secret, identity: { source: "auth", userId: scope.ownerId, handle, runtimeSlot: "primary", sessionProvenance: "clerk-browser", sessionExpiresAt: Math.floor(Date.now() / 1000) + 300 } });
  await controller.submit(f.principal, view!.challengeId, body, proof as string); expect(await authorizing).toBe(true);
  const token = (await source.issue({ operation, invocationId: id, signal })).takeToken();
  let reserved: Parameters<RoutineCliAfterMutationCommit>[0] | undefined;
  // Delayed postcommit transport fixture: real receipt/reservation commits and CLI returns queued before target dispatch.
  const result = await f.service({ ...f.proposals, sources: controller.sources, targets: controller.targets, authorizeTarget: controller.authorizeTarget,
    afterMutationCommit: async input => { reserved = input; } }).execute({ token, operation });
  expect(result).toMatchObject({ receipt: { disposition: "queued" } }); expect(reserved).toBeDefined();
  await source.cancel({ invocationId: id, operation, reason: "finished" });
  if (state === "source-ended") abort.abort();
  if (state === "decision-expired") offset = 61_000;
  if (state === "source-ended-after-claim") {
    const consume = f.proposals.consume; f.proposals.consume = async (binding, currentSignal) => { abort.abort(); return consume(binding, currentSignal); };
  }
  await f.proposals.afterMutationCommit(reserved!); await f.canonical.drain();
  const accepted = state === "live" || state === "source-ended-after-claim";
  expect(await data.db.selectFrom("bot_tasks").select("status").execute()).toEqual(accepted ? [{ status: "waiting_person" }] : []);
  expect(await data.db.selectFrom("bot_approvals").selectAll().execute()).toHaveLength(accepted ? 1 : 0);
  expect(await data.db.selectFrom("bot_routines").selectAll().execute()).toHaveLength(0);
  expect(await data.db.selectFrom("routine_cli_requests").selectAll().execute()).toHaveLength(1);
  expect(vi.mocked(f.runBot).mock.calls.filter(([input]) => input.command.kind === "bot.run")).toHaveLength(0);
});
