import { ROUTINE_ACTION_PATH, ROUTINE_ACTION_PROOF_HEADER } from "@matrix-os/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRoutineCliActionController } from "../../../packages/gateway/src/bots/routine-action-controller.js";
import { createRoutineActionSourceRegistry } from "../../../packages/gateway/src/bots/routine-action-source-registry.js";
import { createRoutineActionOwnerRoutes } from "../../../packages/gateway/src/bots/routine-action-routes.js";
import type { RoutineCliSourceContext } from "../../../packages/gateway/src/bots/routine-cli-source-context.js";
import type { CanonicalProviderRunEvent } from "../../../packages/gateway/src/chat/provider-adapter.js";
import { NOW, at, createBotStateDatabase, insertChat } from "./bot-state-support.js";
import { TARGET_A, TARGET_B, insertRoutine, propose, requestFixture, scope } from "./routine-cli-request-support.js";
import { invocation } from "./routine-cli-source-support.js";

let data: Awaited<ReturnType<typeof createBotStateDatabase>>;
let fixture: Awaited<ReturnType<typeof requestFixture>>;
let registry: ReturnType<typeof createRoutineActionSourceRegistry>;
let controller: ReturnType<typeof createRoutineCliActionController>;
const sourceChatId = "chat_direct_source";
const sourceRunId = "run_direct_source";
const source: RoutineCliSourceContext = { ...scope, harness: "pi", generation: "managed_test_generation",
  identity: { kind: "chat_run", route: "managed", chatId: sourceChatId, runId: sourceRunId },
  actions: ["propose", "read", "control"], issuedAt: NOW, expiresAt: at(120_000) };

beforeEach(async () => {
  data = await createBotStateDatabase();
  fixture = await requestFixture(data.db, { actualSourceOnly: true });
  registry = createRoutineActionSourceRegistry({ now: () => Date.parse(NOW) });
  await insertChat(data.db, sourceChatId);
});

afterEach(async () => {
  controller?.close();
  registry?.close();
  await fixture?.close();
  await data?.destroy();
});

it.each([false, true])("pins an ordinary Chat proposal independently of a remembered Bot (%s)", async (remembered) => {
  if (!remembered) await fixture.targets.reset(fixture.principal, { baseRevision: 1 });
  let prepared = false;
  const ensure = vi.fn(async (origin, signal: AbortSignal) => {
    expect(origin).toEqual({ ...scope, sourceChatId });
    expect(signal.aborted).toBe(false);
    prepared = true;
  });
  controller = createRoutineCliActionController({ db: data.db, scope, agents: fixture.agents, registry,
    now: () => Date.parse(NOW), canAccessTarget: async () => true,
    directChatContexts: { ensure, getWithin: async (_trx, origin) => prepared && origin.sourceChatId === sourceChatId ? TARGET_B : null },
    platform: { handle: "computer-one", machineId: "machine_one", runtimeSlot: "primary",
      verify: async tuple => ({ ...tuple, purpose: "routine_cli_owner_action", version: 1, expiresAt: Date.parse(NOW) + 30_000,
        nonce: "a".repeat(32), bodyDigest: "b".repeat(64) }) } });
  let requested!: (event: Extract<CanonicalProviderRunEvent, { type: "approval.requested" }>) => void;
  const approval = new Promise<Extract<CanonicalProviderRunEvent, { type: "approval.requested" }>>(resolve => { requested = resolve; });
  const registered = await controller.register({ source, signal: new AbortController().signal,
    readPolicy: () => ({ live: true, scope: "personal", permissionMode: "supervised", interactionMode: "default", originCeiling: "exact", revision: "1" }),
    validateWithin: async () => true,
    publish: event => { if (event.type === "approval.requested") requested(event); } });
  const operation = propose(400), call = { operation, invocationId: invocation(401), signal: new AbortController().signal };
  const waiting = registered.authorize(call);
  const review = await Promise.race([approval, waiting.then(() => { throw new Error("Expected an owner action review"); })]);
  expect(ensure).toHaveBeenCalledOnce();
  const ownerRoutes = createRoutineActionOwnerRoutes({ actions: controller, getPrincipal: context => context.req.header("x-test-other-owner")
    ? { ...fixture.principal, userId: "user_other_owner" } : fixture.principal });
  const path = `${ROUTINE_ACTION_PATH}/${review.approvalId}`;
  const view = await ownerRoutes.request(path);
  expect(view.status).toBe(200);
  const projected = await view.json();
  expect(projected).toMatchObject({
    status: "pending", sourceKind: "chat_run", actionDigest: review.actionDigest,
    target: { botId: "matrix-schedules", chatId: sourceChatId },
  });
  expect(JSON.stringify(projected)).not.toContain(TARGET_B.chatId);
  expect(JSON.stringify(projected)).not.toContain(TARGET_B.botId);
  expect((await ownerRoutes.request(path, { headers: { "x-test-other-owner": "1" } })).status).toBe(403);
  expect(await (await ownerRoutes.request(ROUTINE_ACTION_PATH)).json()).toEqual({ challenges: [] });
  await expect(controller.submitChat(scope.ownerId, "chat_another_source", sourceRunId, review.approvalId, {
    actionDigest: review.actionDigest!, decision: "approve", clientRequestId: `req_${"b".repeat(32)}`,
  }, "fixture-proof")).rejects.toMatchObject({ code: "permission_denied" });
  const decision = {
    actionDigest: review.actionDigest!, decision: "approve", clientRequestId: `req_${"a".repeat(32)}`,
  };
  const submit = (proof?: string) => ownerRoutes.request(`${path}/decision`, {
    method: "POST", headers: { "content-type": "application/json", ...(proof ? { [ROUTINE_ACTION_PROOF_HEADER]: proof } : {}) },
    body: JSON.stringify(decision),
  });
  expect((await submit()).status).toBe(403);
  const approved = await submit("fixture-proof");
  expect(approved.status).toBe(200);
  expect(await approved.json()).toEqual({ submission: "accepted" });
  await expect(waiting).resolves.toBe(true);
  const token = (await registered.issue(call)).takeToken();
  const service = fixture.service({ targets: controller.targets, sources: controller.sources, authorizeTarget: controller.authorizeTarget });
  await expect(service.execute({ token, operation })).resolves.toMatchObject({ kind: "receipt", receipt: { disposition: "queued" } });
  expect(await data.db.selectFrom("routine_cli_requests").select("target_snapshot").executeTakeFirstOrThrow()).toEqual({
    target_snapshot: { ...scope, ...TARGET_B, sourceChatId, purpose: "direct_chat", bindingCreatedAt: NOW },
  });
  expect(await fixture.targets.getStoredPreference(fixture.principal)).toMatchObject({ target: remembered ? TARGET_A : null, revision: remembered ? 1 : 2 });

  const directRoutine = await insertRoutine(data.db, 11, TARGET_B);
  const previousRoutine = await insertRoutine(data.db, 12, TARGET_A);
  const list = { operation: "list" } as const;
  const listCall = { ...call, operation: list, invocationId: invocation(402) };
  await expect(registered.authorize(listCall)).resolves.toBe(true);
  const listing = await service.execute({ token: (await registered.issue(listCall)).takeToken(), operation: list });
  expect(listing).toMatchObject({ kind: "list", routines: [
    { routineId: directRoutine }, ...(remembered ? [{ routineId: previousRoutine }] : []),
  ] });
  expect(ensure).toHaveBeenCalledOnce();
});
