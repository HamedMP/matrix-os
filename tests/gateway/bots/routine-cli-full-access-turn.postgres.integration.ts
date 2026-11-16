import { CanonicalProviderCatalogSchema, ROUTINE_FULL_ACCESS_PROOF_HEADER, type RoutineCliOperation } from "@matrix-os/contracts";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { createRoutineCliRuntime } from "../../../packages/gateway/src/bots/routine-cli-runtime.js";
import { createBotRoutineExecution } from "../../../packages/gateway/src/bots/routine-execution.js";
import type { CanonicalChatProviderAdapter, CanonicalProviderRunInput } from "../../../packages/gateway/src/chat/provider-adapter.js";
import { createCanonicalChatRoutes } from "../../../packages/gateway/src/chat/routes.js";
import { createCanonicalChatService } from "../../../packages/gateway/src/chat/service.js";
import { createRoutineActionVerificationRoutes } from "../../../packages/platform/src/routine-action-routes.js";
import { createRoutineFullAccessVerificationRoutes } from "../../../packages/platform/src/routine-full-access-routes.js";
import { authenticatedApprovalProxyProofs } from "../../../packages/platform/src/owner-approval-proofs.js";
import { buildPlatformVerificationToken } from "../../../packages/platform/src/platform-token.js";
import { createRealBotStateDatabase } from "./bot-state-support.js";
import { proposalFixture } from "./routine-cli-proposal-support.js";
import { invocation } from "./routine-cli-source-support.js";
import { insertRoutine, propose, scope, TARGET_A, TARGET_B } from "./routine-cli-request-support.js";

const owner = { type: "personal" as const, ownerId: scope.ownerId };
const handle = "computer-one";
const secret = "fixture-chat-origin-discriminant";
const machine = { handle, machineId: "fixture-machine", runtimeSlot: "primary", clerkUserId: owner.ownerId,
  provisioningClass: "customer" as const, activationState: "authorized" as const, deletedAt: null, status: "running" as const };
const selection = { instanceId: "codex_default", model: "fixture-model" };
const catalog = CanonicalProviderCatalogSchema.parse({
  revision: "fixture-catalog", drivers: [{ kind: "codex", displayName: "Codex", adapterVersion: "1.0.0", capabilityClass: "coding_agent" }],
  instances: [{ id: "codex_default", driverKind: "codex", displayName: "Codex", availability: "available", workspaceRequirement: "project_optional", catalogRevision: "fixture-catalog",
    models: [{ id: "fixture-model", displayName: "Fixture model", availability: "available", capabilities: ["tools"], supportsVision: false, supportsToolUse: true }], options: [], skills: [], commands: [], setupActions: [],
    supports: { rootChat: true, resume: true, cancellation: true, steering: "none", attachments: [], tools: [], approvals: true, userInput: false, worktrees: "none", resources: [], interactionModes: ["default"], permissionModes: ["supervised", "full_access"] } }],
});
const counters = { proof: vi.fn() };
let data: Awaited<ReturnType<typeof createRealBotStateDatabase>>;
let fixture: Awaited<ReturnType<typeof proposalFixture>>;
let runtime: ReturnType<typeof createRoutineCliRuntime>;
const gates: Array<() => void> = [];

afterEach(async () => {
  for (const release of gates.splice(0)) release();
  await runtime?.close();
  await fixture?.close();
  await data?.destroy();
  vi.unstubAllGlobals();
  counters.proof.mockClear();
});

async function setup(work: (input: CanonicalProviderRunInput) => AsyncGenerator<import("../../../packages/gateway/src/chat/provider-adapter.js").CanonicalProviderRunEvent>) {
  const url = process.env.MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL;
  if (!url) throw new Error("MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL is required");
  data = await createRealBotStateDatabase(url, { routineAuthority: true });
  const adapter: CanonicalChatProviderAdapter = { driverKind: "codex", stateSchemaVersion: 1,
    parseState: value => value, serializeState: value => value, start: work };
  fixture = await proposalFixture(data.db, vi.fn, { actualSourceOnly: true, catalog, adapters: [adapter],
    beforeRoutineFullAccessDispatch: input => runtime.beforeRoutineFullAccessDispatch(input) });
  const lookup = { resolveMachine: async () => machine };
  const platform = new Hono();
  platform.route("/", createRoutineFullAccessVerificationRoutes({ platformSecret: secret, lookup }));
  platform.route("/", createRoutineActionVerificationRoutes({ platformSecret: secret, lookup }));
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/routine-full-access/verify")) counters.proof();
    return platform.request(new Request(url, init));
  });
  runtime = createRoutineCliRuntime({ db: data.db, computerId: scope.computerId, configuredOwnerIds: [owner.ownerId],
    agents: fixture.agents, repository: fixture.chats, transact: fixture.transact, approvals: fixture.approvals, registry: fixture.registry,
    control: createBotRoutineExecution({ db: data.db, transact: fixture.transact, approvals: fixture.approvals, available: () => true }),
    platform: { platformUrl: "https://platform.example.test", handle, machineId: machine.machineId, runtimeSlot: machine.runtimeSlot, token: buildPlatformVerificationToken(handle, secret) } });
  runtime.bindCanonical(fixture.canonical);
  fixture.taskDependencies.routineProposals = runtime.proposals;
  const app = new Hono().route("/", createCanonicalChatRoutes({
    service: createCanonicalChatService(fixture.chats, { orchestrator: fixture.canonical }),
    getPrincipal: () => fixture.principal,
  }));
  const newTurn = async (key: string, permissionMode = "full_access") => {
    const chatId = `chat_${key}`, path = `/api/chats/${chatId}/turns`;
    await fixture.chats.create(owner, { id: chatId, clientRequestId: `req_${key}_create`, title: "Private Chat" });
    return { path, chatId, input: { permissionMode, interactionMode: "default", selection, baseRevision: 0,
      clientRequestId: `req_${key}_turn`, parts: [{ type: "text", text: "Propose a routine" }] } };
  };
  const requestTurn = (path: string, raw: object, proof?: string) => app.request(path, { method: "POST",
    headers: { "content-type": "application/json", ...(proof ? { [ROUTINE_FULL_ACCESS_PROOF_HEADER]: proof } : {}) }, body: JSON.stringify(raw) });
  return { newTurn, requestTurn };
}

async function proofFor(path: string, body: object) {
  const sessionExpiresAt = Math.floor(Date.now() / 1000) + 120;
  const result = await authenticatedApprovalProxyProofs({
    request: new Request(`https://app.example.test${path}`, { method: "POST", body: JSON.stringify(body) }),
    method: "POST", path, handle, machine, platformSecret: secret,
    identity: { handle, userId: owner.ownerId, runtimeSlot: machine.runtimeSlot, source: "auth",
      sessionProvenance: "clerk-browser", sessionExpiresAt, verifiedHumanBrowserExpiresAt: sessionExpiresAt },
  });
  expect(result).toEqual([expect.any(String)]);
  return (result as string[])[0]!;
}

it("browser-attested Full Access uses a real capability and leaves a separate canonical schedule approval", async () => {
  const operation = propose(860);
  const toolResult = Promise.withResolvers<Awaited<ReturnType<typeof runtime.execute>>>();
  const readAfterDrift = Promise.withResolvers<void>();
  const historicalReceipt = Promise.withResolvers<Awaited<ReturnType<typeof runtime.execute>>>();
  gates.push(readAfterDrift.resolve);
  const publish = vi.fn();
  const chat = await setup(async function* (input) {
    try {
      const source = await runtime.registerChat({ input, provider: "codex", signal: input.signal, current: () => !input.signal.aborted, publish });
      const call = { operation, invocationId: invocation(861), signal: input.signal };
      await expect(source.authorize(call)).resolves.toBe(true);
      const token = (await source.issue(call)).takeToken();
      toolResult.resolve(await runtime.execute({ operation, token }));
      await readAfterDrift.promise;
      const read = { operation: { operation: "request" as const, requestId: operation.requestId },
        invocationId: invocation(867), signal: input.signal };
      await expect(source.authorize(read)).resolves.toBe(true);
      historicalReceipt.resolve(await runtime.execute({ operation: read.operation, token: (await source.issue(read)).takeToken() }));
    } catch (error: unknown) {
      toolResult.reject(error);
      historicalReceipt.reject(error);
    }
    yield { type: "run.completed", outcome: "completed" };
  });
  const turn = await chat.newTurn("full_access_fixture");
  const proof = await proofFor(turn.path, turn.input);
  const response = await chat.requestTurn(turn.path, turn.input, proof);
  expect(response.status).toBe(202);
  await expect(toolResult.promise).resolves.toMatchObject({ kind: "receipt", receipt: { requestId: operation.requestId, disposition: "queued" } });
  await expect.poll(() => data.db.selectFrom("routine_cli_proposals").select("stage")
    .where("client_request_id", "=", operation.requestId).executeTakeFirst(), { timeout: 3_000 })
    .toMatchObject({ stage: "pending_approval" });
  await fixture.targets.remember(fixture.principal, { ...TARGET_B, baseRevision: 1 });
  readAfterDrift.resolve();
  await expect(historicalReceipt.promise).resolves.toMatchObject({ kind: "receipt", receipt: { requestId: operation.requestId } });
  await fixture.canonical.drain();
  expect(publish).not.toHaveBeenCalled();
  expect(counters.proof).toHaveBeenCalledTimes(1);
  expect(await data.db.selectFrom("bot_approvals").select(["tool", "status"]).execute())
    .toEqual([{ tool: "routine.activate", status: "pending" }]);
  expect(await data.db.selectFrom("bot_routines").select("routine_id").execute()).toEqual([]);
  const duplicate = await chat.requestTurn(turn.path, turn.input, proof);
  expect(await duplicate.json()).toMatchObject({ admission: "already_accepted" });
  expect(counters.proof).toHaveBeenCalledTimes(1);
}, 10_000);

it("a new destination revision fences an issued Full Access capability before consume", async () => {
  const operation = propose(862);
  const token = Promise.withResolvers<string>(), use = Promise.withResolvers<void>(), outcome = Promise.withResolvers<unknown>();
  gates.push(use.resolve);
  const chat = await setup(async function* (input) {
    try {
      const source = await runtime.registerChat({ input, provider: "codex", signal: input.signal, current: () => !input.signal.aborted, publish: vi.fn() });
      const call = { operation, invocationId: invocation(863), signal: input.signal };
      expect(await source.authorize(call)).toBe(true);
      const issued = (await source.issue(call)).takeToken();
      token.resolve(issued);
      await use.promise;
      await runtime.execute({ operation, token: issued });
      outcome.resolve(null);
    } catch (error: unknown) { token.reject(error); outcome.resolve(error); }
    yield { type: "run.completed", outcome: "completed" };
  });
  const turn = await chat.newTurn("full_access_target_drift");
  expect((await chat.requestTurn(turn.path, turn.input, await proofFor(turn.path, turn.input))).status).toBe(202);
  await token.promise;
  await fixture.targets.remember(fixture.principal, { ...TARGET_B, baseRevision: 1 });
  use.resolve();
  await expect(outcome.promise).resolves.toMatchObject({ code: "permission_denied" });
  expect(await data.db.selectFrom("routine_cli_requests").select("client_request_id").execute()).toEqual([]);
  expect(await data.db.selectFrom("bot_approvals").select("approval_id").execute()).toEqual([]);
  expect((await fixture.targets.getDefault(fixture.principal)).target).toMatchObject(TARGET_B);
  expect((await fixture.targets.getDefault(fixture.principal)).target).not.toMatchObject(TARGET_A);
}, 10_000);

it.each(["supervised", "no proof", "wrong chat"] as const)("%s keeps a source operation confirmation", async mode => {
  const operation = propose(864), publish = vi.fn(), done = Promise.withResolvers<void>();
  const chat = await setup(async function* (input) {
    const events: import("../../../packages/gateway/src/chat/provider-adapter.js").CanonicalProviderRunEvent[] = [];
    let notify: (() => void) | undefined;
    const source = await runtime.registerChat({ input, provider: "codex", signal: input.signal, current: () => !input.signal.aborted,
      publish(event) { publish(event); events.push(event); notify?.(); } });
    const waiting = source.authorize({ operation, invocationId: invocation(865), signal: input.signal });
    try {
      while (!events.length) await Promise.race([new Promise<void>(resolve => { notify = resolve; }), waiting.then(() => { throw new Error("Expected source confirmation"); })]);
      yield events.shift()!;
      expect(await waiting).toBe(false);
      done.resolve();
    } catch (error: unknown) { done.reject(error); }
    yield { type: "run.completed", outcome: "completed" };
  });
  const turn = await chat.newTurn("access_ceiling", mode === "supervised" ? "supervised" : "full_access");
  const wrongChat = mode === "wrong chat" ? await chat.newTurn("another_chat") : undefined;
  const proof = wrongChat ? await proofFor(wrongChat.path, turn.input) : undefined;
  const response = await chat.requestTurn(turn.path, turn.input, proof);
  expect(response.status).toBe(202);
  // Administrative test fixture cleanup uses the existing signed exact-operation cancellation.
  await expect.poll(() => publish.mock.calls[0]?.[0]?.type, { timeout: 3_000 }).toBe("approval.requested");
  const event = publish.mock.calls[0]![0];
  const path = `/api/routine-cli/actions/${event.approvalId}/decision`;
  const body = { actionDigest: event.actionDigest, decision: "cancel" as const, clientRequestId: invocation(866) };
  const signedAction = await proofFor(path, body);
  await expect(runtime.submit(fixture.principal, event.approvalId, body, signedAction)).resolves.toEqual({ submission: "accepted" });
  await expect(done.promise).resolves.toBeUndefined();
  expect(counters.proof).toHaveBeenCalledTimes(mode === "wrong chat" ? 1 : 0);
  expect(await data.db.selectFrom("routine_cli_requests").select("client_request_id").execute()).toEqual([]);
}, 10_000);

it("direct controls retain optimistic revisions and the stored archive", async () => {
  const result = Promise.withResolvers<void>(), publish = vi.fn();
  let routineId: string;
  const chat = await setup(async function* (input) {
    try {
      const source = await runtime.registerChat({ input, provider: "codex", signal: input.signal, current: () => !input.signal.aborted, publish });
      const execute = async (operation: RoutineCliOperation, id: number) => {
        const call = { operation, invocationId: invocation(id), signal: input.signal };
        await expect(source.authorize(call)).resolves.toBe(true);
        return runtime.execute({ operation, token: (await source.issue(call)).takeToken() });
      };
      const pause = { operation: "pause", requestId: invocation(868), routineId, baseRevision: 1 } as const;
      const archive = { operation: "archive", requestId: invocation(869), routineId, baseRevision: 2 } as const;
      await expect(execute(pause, 870)).resolves.toMatchObject({ kind: "receipt", receipt: { routine: { status: "paused", revision: 2 } } });
      await expect(execute({ ...archive, requestId: invocation(871), baseRevision: 1 }, 872)).rejects.toMatchObject({ code: "revision_conflict" });
      await expect(execute(archive, 873)).resolves.toMatchObject({ kind: "receipt", receipt: { routine: { status: "archived", revision: 3 } } });
      result.resolve();
    } catch (error: unknown) { result.reject(error); }
    yield { type: "run.completed", outcome: "completed" };
  });
  routineId = await insertRoutine(data.db, 860);
  const turn = await chat.newTurn("full_access_controls");
  expect((await chat.requestTurn(turn.path, turn.input, await proofFor(turn.path, turn.input))).status).toBe(202);
  await result.promise;
  await fixture.canonical.drain();
  expect(publish).not.toHaveBeenCalled();
  expect(await data.db.selectFrom("bot_routines").select(["status", "revision"]).where("routine_id", "=", routineId).executeTakeFirst())
    .toEqual({ status: "archived", revision: "3" });
  expect(await data.db.selectFrom("bot_approvals").select("approval_id").execute()).toEqual([]);
}, 10_000);
