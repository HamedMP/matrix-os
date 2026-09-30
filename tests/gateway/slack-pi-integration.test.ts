/**
 * Composed Slack -> owner bridge -> canonical shared queue -> real Pi loop -> Slack.
 * External organization/provider projections and sandbox/HTTP transports are fixtures;
 * admission, policies, run binding, bot startup, broker and output commits are production.
 * This does not qualify Slack OAuth, the Linux sandbox or paid inference deployment.
 */
import { createHash, createHmac, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "node:net";
import type { Kysely } from "kysely";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import type { AiProviderSnapshotV3, BotModelRoute } from "@matrix-os/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runBotTurn } from "../../packages/bot-runtime/src/loop.js";
import { createBotBrokerClient } from "../../packages/bot-runtime/src/broker-client.js";
import { ChatAgentStore } from "../../packages/gateway/src/chat/agent-store.js";
import { createChatExecutionRootResolver } from "../../packages/gateway/src/chat/execution-root.js";
import type { ChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry } from "../../packages/gateway/src/chat/provider-adapter.js";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import { bootstrapCollaborationDatabase, type OwnerCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { OwnerAccountEligibility } from "../../packages/gateway/src/collaboration/account-eligibility.js";
import { CollaborationExecutionPolicyRepository } from "../../packages/gateway/src/collaboration/execution-policy.js";
import { CollaborationRunBindingRepository } from "../../packages/gateway/src/collaboration/run-account-binding.js";
import { SharedRunOwnerSource } from "../../packages/gateway/src/collaboration/shared-run-owner-source.js";
import { CollaborationChatExecutionAdapter } from "../../packages/gateway/src/collaboration/chat-execution-adapter.js";
import { prepareSharedMatrixBotAdapter, resolveSharedMatrixBotReadiness } from "../../packages/gateway/src/collaboration/shared-matrix-bot.js";
import { SHARED_MATRIX_BOT_ELIGIBILITY } from "../../packages/gateway/src/collaboration/shared-ai-eligibility.js";
import { MATRIX_BOT_SELECTION } from "../../packages/gateway/src/bots/selection.js";
import { startBots, type BotServices } from "../../packages/gateway/src/startup/bots.js";
import { createCompanyBotSetup, startSlackCompany } from "../../packages/gateway/src/startup/slack-company.js";
import { createSlackBridgeRoutes } from "../../packages/gateway/src/startup/slack-bridge.js";
import { createSlackOwnerClient } from "../../packages/gateway/src/startup/slack-owner-client.js";
import { createSlackApp } from "../../packages/platform/src/slack/wiring.js";
import type { SlackDatabase } from "../../packages/platform/src/slack/database.js";
import { encryptSlackToken } from "../../packages/platform/src/slack/security.js";
import { createSlackHomeTransport } from "../../packages/platform/src/slack-home-transport.js";
import type { ScopeRuntimeHost } from "../../packages/gateway/src/scope-runtime-host/index.js";
import type { GatewayCollaborationRuntime } from "../../packages/gateway/src/collaboration/wiring.js";
import type { BotRunSpec } from "@matrix-os/contracts";
import { createBotStateDatabase, createRealBotStateDatabase } from "./bots/bot-state-support.js";
import { allowAllOrganizationPrecondition, collaborationActors as actors, collaborationIds as ids, collaborationExecutionEligibility } from "./collaboration-test-support.js";

const ORG = "org_team";
const SOURCE = "owner_anthropic_key";
const INSTANCE = "company_anthropic";
const PROJECT = "company_project";
const TOKEN = "a".repeat(64);
const ANSWER = "The company launch is Monday. See https://example.com/launch";
const ROUTE: BotModelRoute = { api: "anthropic-messages", modelId: "faux-bot", input: ["text"], contextWindow: 200_000, maxOutputTokens: 8_192 };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); vi.restoreAllMocks(); });

function snapshot(): AiProviderSnapshotV3 {
  const readiness = { state: "ready" as const, checkedAt: new Date().toISOString(), staleAfter: null, action: "none" as const, safeReason: null };
  return { contractVersion: 3, revision: 1, refreshedAt: readiness.checkedAt, drivers: [], accounts: [], models: [{ id: ROUTE.modelId, vendor: "anthropic", displayName: "Faux company model", status: "current",
      capabilities: ["tools"], effortControls: [], eligibleAccessSourceIds: [SOURCE], dataPolicies: [{ accessSourceId: SOURCE, route: "owner_direct", disclosureKey: "owner-direct" }], aliases: [], catalogVersion: "fixture-models" }],
    accessSources: [{ ...readiness, id: SOURCE, displayName: "Company selected key", fundingKind: "owner_api_key", vendor: "anthropic", accountLabel: null, eligibleModelIds: [ROUTE.modelId], policyVersion: "company-policy" }],
    instances: [{ id: INSTANCE, driverId: "claude_code", vendor: "anthropic", accountId: null, accessSourceId: SOURCE,
      label: "Company selected source", readiness, capabilitySnapshot: [], modelIds: [ROUTE.modelId], defaultModelId: ROUTE.modelId, catalogVersion: "fixture-models" }],
    active: { providerInstanceId: INSTANCE, accessSourceId: SOURCE, modelId: ROUTE.modelId } };
}

/** Supervisor wire substitute; all frames still pass the real client schema and broker. */
function socketTransport(handleFrame: (frame: unknown) => Promise<unknown>): Socket {
  const socket = new EventEmitter() as EventEmitter & { setTimeout(): unknown; destroy(): unknown; end(body: string): unknown };
  socket.setTimeout = () => socket;
  socket.destroy = () => socket;
  socket.end = (body) => {
    void handleFrame(JSON.parse(body)).then(
      reply => socket.emit("data", Buffer.from(`${JSON.stringify(reply)}\n`)),
      error => socket.emit("error", error),
    );
    return socket;
  };
  queueMicrotask(() => socket.emit("connect"));
  return socket as unknown as Socket;
}

async function setup() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-30T12:00:00Z"));
  const fixture = await (process.env.MATRIX_TEST_POSTGRES_URL ? createRealBotStateDatabase() : createBotStateDatabase());
  cleanup.push(fixture.destroy);
  const home = await mkdtemp(join(tmpdir(), "matrix-slack-pi-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const projectPath = join(home, "projects", "company");
  await mkdir(projectPath, { recursive: true });
  const db = fixture.db as unknown as Kysely<OwnerCollaborationDatabase>;
  await bootstrapCollaborationDatabase(db);
  const chats = new ChatRepository(db as unknown as Kysely<ChatDatabase>);
  const agents = new ChatAgentStore({ homePath: home, db: db as unknown as Kysely<ChatDatabase> });
  await agents.bootstrap(); cleanup.push(() => agents.close());
  const scopes = new CollaborationRepository(db);
  await scopes.createDirectScope({ scopeId: ids.scope, ownerId: actors.owner, organizationId: ORG,
    kind: "project", resourceId: PROJECT, authorityRuntimeId: ids.runtime });
  await db.updateTable("collaboration_scopes").set({ lifecycle: "shared" }).where("id", "=", ids.scope).execute();
  await db.insertInto("collaboration_members").values({ scope_id: ids.scope, actor_id: actors.editor, role: "editor", status: "accepted",
    invitation_id: null, invited_by: actors.owner, accepted_at: new Date().toISOString(), expires_at: null,
    revision: 1, joined_at: new Date().toISOString(), updated_at: new Date().toISOString() }).execute();
  const authority = new CollaborationAuthority(scopes, { organizationPrecondition: allowAllOrganizationPrecondition });
  chats.setSharedAuthorizer((scopeId, actorId, action) => authority.authorize({ scopeId, actorId, action }));
  const eligibility = new OwnerAccountEligibility({ snapshots: { getSnapshotV3: async owner => { expect(owner).toBe(actors.owner); return snapshot(); } } });
  const policies = new CollaborationExecutionPolicyRepository(db, { eligibility, organizationAiSubmission: { resolve: async () => "members" } });
  await policies.put({ scopeId: ids.scope, actorId: actors.owner, payloadHash: createHash("sha256").update("policy").digest("hex"), request: {
    clientRequestId: randomUUID(), expectedRevision: "0", accessSourceId: SOURCE, providerInstanceId: INSTANCE,
    submitMode: "follow_organization", acknowledgeProviderTerms: true, allowedModelIds: [ROUTE.modelId] } });
  const bindings = new CollaborationRunBindingRepository(db, { policies, eligibility });
  const ownerSource = new SharedRunOwnerSource({ policies, eligibility, bindings });
  const roots = createChatExecutionRootResolver({ homePath: home,
    projects: { async getProjectById(owner, projectId) {
      expect(owner).toEqual({ type: "user", id: actors.owner }); expect(projectId).toBe(PROJECT);
      return { ok: true, project: { id: PROJECT, slug: "company", localPath: projectPath } };
    }, resolveProjectWorkingDirectory: async () => projectPath }, worktrees: { getWorktree: async () => ({ ok: false, status: 404, error: "absent" }) } });
  let bots: BotServices | undefined;
  const company = createCompanyBotSetup({ homePath: home, ownerId: actors.owner, repository: chats,
    collaboration: { authority, executionPolicies: policies, ownerSource, runBindings: bindings } as unknown as GatewayCollaborationRuntime,
    providers: { getSnapshot: async () => snapshot() }, getBots: () => bots, modelId: ROUTE.modelId });
  if (!company) throw new Error("Company Pi setup unavailable");
  cleanup.push(() => { company.close(); return Promise.resolve(); });
  const faux = fauxProvider({ models: [{ id: ROUTE.modelId, input: ["text"], contextWindow: ROUTE.contextWindow, maxTokens: ROUTE.maxOutputTokens }] });
  faux.setResponses([fauxAssistantMessage(fauxText("Company thread initialized.")), fauxAssistantMessage(fauxText(ANSWER))]);
  const stream = vi.spyOn(faux.provider, "streamSimple");
  const specs: BotRunSpec[] = [];
  let frames: ((frame: unknown) => Promise<unknown>) | undefined;
  const createRuntime = vi.fn(async input => {
    expect(input).toMatchObject({ workload: "bot_agent", sandbox: { actorId: expect.any(String), network: "broker_only", worktree: { hostPath: await realpath(projectPath) } } });
    return { runtimeHandle: `runtime_${randomUUID().replaceAll("-", "")}`, executionGeneration: "1" };
  });
  const host = { available: true, registerAuthorizer(authorizer: Parameters<ScopeRuntimeHost["registerAuthorizer"]>[0]) {
    frames = authorizer.handleFrame; return () => { frames = undefined; };
  }, client: { createRuntime, stopRuntime: async () => undefined, async runBot(input: Parameters<ScopeRuntimeHost["client"]["runBot"]>[0]) {
    if (input.command.kind !== "bot.run") return { ok: true, reply: {} };
    const broker = createBotBrokerClient({ ...input, runId: input.command.runId, socketPath: "transport-fixture",
      connectFn: () => socketTransport(frame => frames!(frame)) });
    const spec = await broker.loadRun(); specs.push(spec);
    const reply = await runBotTurn({ command: { version: 1, kind: "bot.run", runId: input.command.runId, ...spec }, broker,
      bridgeOrigin: "http://127.0.0.1:41000", route: { provider: faux.provider, model: faux.getModel() } });
    return { ok: true, reply };
  } } } as unknown as ScopeRuntimeHost;
  bots = await startBots({ homePath: home, repository: chats, agents, executionRoots: roots, providers: { getSnapshot: async () => snapshot() }, host, group: company });
  expect(bots?.adapter).toBeDefined(); cleanup.push(() => bots!.close());
  const privateMemory = vi.spyOn(bots!.memory, "admitted");
  const canonical = new CanonicalChatOrchestrator({ repository: chats, executionRoots: roots,
    adapters: new CanonicalChatProviderRegistry([bots!.adapter!]), catalog: { getCatalog: async () => { throw new Error("Private catalog must not be consulted"); } } });
  cleanup.push(() => canonical.close());
  const readinessChecks: Array<{ boundDriverKind: string | null; result: string }> = [];
  const execution = new CollaborationChatExecutionAdapter({ repository: chats,
    commands: { cancel: async () => { throw new Error("unused"); }, retry: async () => { throw new Error("unused"); }, decideApproval: async () => { throw new Error("unused"); } },
    resolveParticipant: async actorId => ({ actorId, displayName: actorId }), resolveEffectiveSubmitMode: scopeId => policies.effectiveSubmitMode(scopeId),
    resolveOwnerSourceAdmission: (scopeId, ownerId) => ownerSource.admission({ scopeId, ownerId }),
    resolveEligibility: async scopeId => (await db.selectFrom("collaboration_scopes").select("execution_eligibility").where("id", "=", scopeId).executeTakeFirstOrThrow()).execution_eligibility,
    resolveProviderReadiness: async (ownerId, selection, boundDriverKind) => {
      const result = await resolveSharedMatrixBotReadiness({ ownerId, selection, boundDriverKind, extension: company.matrixBot, standard: async () => "unavailable" });
      readinessChecks.push({ boundDriverKind, result }); return result;
    },
    resolveCanonicalProviderAuthority: async () => ({ driverKind: "matrix_bot", selection: MATRIX_BOT_SELECTION }),
    resolveResourceRevision: async (_scopeId, chatId) => (await db.selectFrom("chats").select("revision").where("id", "=", chatId).executeTakeFirstOrThrow()).revision,
    resolveExecutionRoot: async context => {
      const chat = await db.selectFrom("chats").select("project_id").where("id", "=", context.resourceId).executeTakeFirstOrThrow();
      if (!chat.project_id) throw new Error("Project root required");
      const root = await roots.resolve({ type: "personal", ownerId: context.ownerId }, { kind: "project", projectId: chat.project_id });
      if (root.ref.kind === "bot_workspace") throw new Error("Private root forbidden");
      return { ref: root.ref, fingerprint: root.fingerprint };
    }, requestDispatch: async (scopeId, chatId) => canonical.dispatchNextSharedQueued({ type: "personal", ownerId: actors.owner }, chatId, scopeId, async (execution, run) => {
      const context = await authority.authorize({ scopeId, actorId: execution.requestingActorId, action: "request_ai" });
      return prepareSharedMatrixBotAdapter({ execution, run, context, ownerSource, extension: company.matrixBot, async admit(decision, modelId) {
        await bindings.admit({ runId: run.id, requestId: execution.queuedTurnId, scopeId, requestingActorId: execution.requestingActorId,
          expectedPolicyRevision: decision.policyRevision, executionRoot: run.executionRoot ?? null, rootFingerprint: run.executionRootFingerprint!,
          audienceGeneration: String(context.authEpoch), harness: decision.harness, modelId });
      } });
    }) });
  const collaboration = { authority, executionPolicies: policies, ownerSource, runBindings: bindings, chatExecutionAdapter: execution,
    sharedAiCapability: { generation: 1, eligibility: { ...collaborationExecutionEligibility(), matrixBot: SHARED_MATRIX_BOT_ELIGIBILITY } } } as unknown as GatewayCollaborationRuntime;
  return { fixture, db, home, chats, authority, roots, bots: bots!, canonical, collaboration, specs, stream, privateMemory, createRuntime, readinessChecks };
}

async function setupSlack(s: Awaited<ReturnType<typeof setup>>, beforeMetadata?: () => Promise<void>) {
  const platformFixture = await createBotStateDatabase(); cleanup.push(platformFixture.destroy);
  const config = { appId: "A123", clientId: "123.456", clientSecret: "c".repeat(32), signingSecret: "s".repeat(32),
    tokenEncryptionKey: Buffer.alloc(32, 42).toString("base64"), publicBaseUrl: "https://platform.test" };
  let bridge: ReturnType<typeof createSlackBridgeRoutes>;
  const home = { ownerId: actors.owner, origin: "https://owner.test", token: TOKEN };
  const homeRpc = createSlackHomeTransport({ fetchImpl: (async (url, init) => bridge.request(new Request(String(url), init))) as typeof fetch });
  const posts = vi.fn(async () => ({ ts: "1790766001.000001" }));
  const platform = await createSlackApp({ db: platformFixture.db as unknown as Kysely<SlackDatabase>, config, startCleanup: false,
    api: { exchangeCode: async () => { throw new Error("unused"); }, postMessage: posts, conversationInfo: async () => { await beforeMetadata?.(); return { isExternalShared: false, canAccess: true }; },
    replies: async () => ({ messages: [{ user: "U123", ts: "1790766000.000001", text: "Launch is Monday" }], hasMore: false }),
    history: async () => ({ messages: [], hasMore: false }), addReaction: async () => undefined },
    resolveActor: async () => actors.owner, requireOrgAdmin: async () => true, isCurrentMember: async () => true,
    authorizeChannelBinding: async input => (await homeRpc(home, "authorize", { ownerId: actors.owner, organizationId: ORG, actorId: input.actorId, scopeId: input.scopeId, action: "manage_members" })).allowed === true,
    authenticateRuntime: async c => c.req.header("authorization") === `Bearer ${TOKEN}` && c.req.header("x-matrix-handle") === "company-owner" ? { ownerId: actors.owner } : null,
    authorizeReply: async ({ destination, ownerId, publication }) => ownerId === actors.owner && (await homeRpc(home, "authorize", {
      ownerId, organizationId: ORG, actorId: destination.actorId, scopeId: destination.scopeId,
      ...(publication ? { action: "publish_reply", appId: destination.appId, teamId: destination.teamId, eventId: destination.eventId, textDigest: publication.textDigest } : { action: "discuss" }),
    })).allowed === true,
    dispatch: async ({ installation, link, binding, event, signal }) => {
    await homeRpc(home, "events", { ownerId: actors.owner, organizationId: installation.organizationId, actorId: link.actorId,
      channelScopeId: binding!.scopeId, companyPublicationApproved: binding!.approvedOutput, event }, signal);
    return { ownerId: actors.owner };
    } });
  cleanup.push(() => platform.close());
  const client = createSlackOwnerClient({ platformUrl: config.publicBaseUrl, handle: "company-owner", token: TOKEN,
    fetchImpl: (async (url, init) => platform.routes.request(new Request(String(url), init))) as typeof fetch });
  const company = await startSlackCompany({ ownerId: actors.owner, repository: s.chats, collaboration: s.collaboration, executionRoots: s.roots, bots: s.bots, client });
  cleanup.push(() => company.close()); expect(company.service).toBeDefined();
  bridge = createSlackBridgeRoutes({ ownerId: actors.owner, token: TOKEN, authority: s.authority, receive: input => company.service!.receive(input), authorizePublication: input => company.service!.authorizePublication(input) });
  await company.brain.publish(ids.scope, actors.owner, { sourceId: "b".repeat(64), audienceScopeId: ids.scope, title: "Launch decision", text: "The company launch is Monday",
    permalink: "https://example.com/launch", sourceUpdatedAt: new Date().toISOString(), expectedRevision: 0 });
  await platform.repository.saveInstallation({ appId: "A123", teamId: "T123", organizationId: ORG, installedBy: actors.owner, botUserId: "UBOT",
    encryptedBotToken: encryptSlackToken("xoxb-fixture", config.tokenEncryptionKey, "A123:T123") });
  await platform.repository.createChallenge({ hash: "d".repeat(64), appId: "A123", teamId: "T123", slackUserId: "U123" });
  await platform.repository.completeLink({ hash: "d".repeat(64), actorId: actors.editor, organizationId: ORG });
  await platform.repository.saveChannelBinding({ appId: "A123", teamId: "T123", organizationId: ORG, channelId: "C123", scopeId: ids.scope, approvedOutput: true, configuredBy: actors.owner });
  const payload = { type: "event_callback", api_app_id: "A123", team_id: "T123", event_id: "EvPI123",
    event: { type: "app_mention", user: "U123", channel: "C123", text: "<@UBOT> When is the company launch?", ts: "1790766000.000001" } };
  const signed = () => {
    const body = JSON.stringify(payload); const timestamp = String(Math.floor(Date.now() / 1000));
    return { method: "POST", body, headers: { "content-type": "application/json", "x-slack-request-timestamp": timestamp,
    "x-slack-signature": `v0=${createHmac("sha256", config.signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")}` } };
  };
  return { company, platform, posts, payload, signed, authorizePublication: (input: unknown) => homeRpc(home, "authorize", input), platformDb: platformFixture.db as unknown as Kysely<SlackDatabase>, restart: async () => {
    const next = await startSlackCompany({ ownerId: actors.owner, repository: s.chats, collaboration: s.collaboration, executionRoots: s.roots, bots: s.bots, client });
    bridge = createSlackBridgeRoutes({ ownerId: actors.owner, token: TOKEN, authority: s.authority, receive: input => next.service!.receive(input), authorizePublication: input => next.service!.authorizePublication(input) });
    return next;
  } };
}

describe("Slack company Pi composition", () => {
  it("initializes an unbound company Chat as its owner, runs an employee through Pi, and publishes the exact committed output", async () => {
    const s = await setup();
    const { company, platform, posts, payload, signed, restart, platformDb } = await setupSlack(s);
    expect((await platform.routes.request("/webhooks/slack/events", signed())).status).toBe(200);
    expect(await s.db.selectFrom("chat_queued_turns").selectAll().execute()).toEqual([]);
    await company.service!.drain();
    await vi.waitFor(async () => {
      expect(await s.db.selectFrom("chat_runs").select("status").execute()).toEqual([{ status: "completed" }, { status: "completed" }]);
    }, { timeout: 10_000 });
    await company.close();
    const restarted = await restart(); cleanup.push(() => restarted.close());
    await restarted.service!.drain();
    expect(posts).toHaveBeenCalledOnce();
    expect(posts).toHaveBeenCalledWith(expect.objectContaining({ channelId: "C123", threadTs: payload.event.ts, text: ANSWER }));
    const runs = await s.db.selectFrom("chat_runs").select(["id", "driver_kind", "status"]).orderBy("created_at").execute();
    expect(runs).toEqual([expect.objectContaining({ driver_kind: "matrix_bot", status: "completed" }),
      expect.objectContaining({ driver_kind: "matrix_bot", status: "completed" })]);
    expect(s.specs).toHaveLength(2); expect(s.specs[1]!.turn).toMatchObject({ kind: "prompt", text: expect.stringContaining("The company launch is Monday") });
    expect(s.specs[1]!.capabilities).toEqual(["integration.inventory", "integration.call"]);
    expect(s.stream).toHaveBeenCalledTimes(2); expect(s.privateMemory).not.toHaveBeenCalled();
    expect(s.readinessChecks).toContainEqual({ boundDriverKind: null, result: "ready" });
    expect(s.createRuntime.mock.calls.map(([input]) => input.sandbox.actorId)).toEqual([actors.owner, actors.editor]);
    expect(JSON.stringify(s.stream.mock.calls[1]![1])).not.toContain("Company thread initialized.");
    const tasks = await s.fixture.db.selectFrom("bot_tasks").select("status").execute();
    expect(tasks).toEqual([{ status: "completed" }, { status: "completed" }]);
    const sourceBindings = await s.db.selectFrom("collaboration_run_bindings").select(["access_source_id", "provider_instance_id", "requesting_actor_id", "model_id", "execution_root", "root_fingerprint"]).execute();
    expect(sourceBindings).toHaveLength(2);
    expect(sourceBindings).toEqual(expect.arrayContaining([expect.objectContaining({ access_source_id: SOURCE, provider_instance_id: INSTANCE, requesting_actor_id: actors.owner, model_id: ROUTE.modelId }),
      expect.objectContaining({ access_source_id: SOURCE, provider_instance_id: INSTANCE, requesting_actor_id: actors.editor, model_id: ROUTE.modelId })]));
    const expectedRoot = await s.roots.resolve({ type: "personal", ownerId: actors.owner }, { kind: "project", projectId: PROJECT });
    expect(sourceBindings.map(binding => ({ root: binding.execution_root, fingerprint: binding.root_fingerprint }))).toEqual([
      { root: expectedRoot.ref, fingerprint: expectedRoot.fingerprint }, { root: expectedRoot.ref, fingerprint: expectedRoot.fingerprint }]);
    const queued = await s.db.selectFrom("chat_queued_turns").select(["id", "requesting_actor_id", "status", "claimed_run_id"]).where("requesting_actor_id", "=", actors.editor).executeTakeFirstOrThrow();
    const output = await s.db.selectFrom("chat_messages").select("parts").where("run_id", "=", queued.claimed_run_id!).where("role", "=", "assistant").executeTakeFirstOrThrow();
    expect(output.parts).toEqual([{ type: "text", text: ANSWER }]);
    const receipt = await platformDb.selectFrom("slack_event_receipts").select(["state", "destination_owner_id", "actor_id", "channel_id", "thread_ts", "scope_id"]).executeTakeFirstOrThrow();
    expect(receipt).toEqual({ state: "completed", destination_owner_id: actors.owner, actor_id: actors.editor, channel_id: "C123", thread_ts: payload.event.ts, scope_id: ids.scope });
    expect(await platformDb.selectFrom("slack_reply_intents").select("state").execute()).toEqual([{ state: "sent" }]);
    expect((await platform.routes.request("/webhooks/slack/events", signed())).status).toBe(200);
    await restarted.service!.drain(); expect(posts).toHaveBeenCalledOnce(); expect(s.stream).toHaveBeenCalledTimes(2);
  }, 20_000);
  it("withholds actual Pi output when the employee loses Project authority before publication", async () => {
    const s = await setup();
    const { company, platform, posts, signed } = await setupSlack(s);
    expect((await platform.routes.request("/webhooks/slack/events", signed())).status).toBe(200);
    await company.service!.drain();
    await vi.waitFor(async () => {
      expect(await s.db.selectFrom("chat_runs").select("status").execute()).toEqual([{ status: "completed" }, { status: "completed" }]);
    }, { timeout: 10_000 });
    await s.db.updateTable("collaboration_members").set({ status: "revoked" })
      .where("scope_id", "=", ids.scope).where("actor_id", "=", actors.editor).execute();
    await company.service!.drain();
    expect(posts).not.toHaveBeenCalled();
    expect(s.stream).toHaveBeenCalledTimes(2);
  }, 20_000);

  it("withholds actual Pi evidence erased during Slack channel metadata latency", async () => {
    const s = await setup();
    let erase = false;
    const { company, platform, posts, signed } = await setupSlack(s, async () => {
      if (erase) { erase = false; await company.brain.erase(ids.scope, actors.owner); }
    });
    expect((await platform.routes.request("/webhooks/slack/events", signed())).status).toBe(200);
    await company.service!.drain();
    await vi.waitFor(async () => {
      expect(await s.db.selectFrom("chat_runs").select("status").execute()).toEqual([{ status: "completed" }, { status: "completed" }]);
    }, { timeout: 10_000 });
    erase = true;
    await company.service!.drain();
    expect(posts).not.toHaveBeenCalled();
    expect(s.stream).toHaveBeenCalledTimes(2);
  }, 20_000);

  it("binds publication authorization to the exact sending receipt, actor, scope and output digest", async () => {
    const s = await setup();
    let inspect = false;
    const native = await setupSlack(s, async () => {
      if (!inspect) return; inspect = false;
      const request = { ownerId: actors.owner, organizationId: ORG, actorId: actors.editor, scopeId: ids.scope, action: "publish_reply",
        appId: "A123", teamId: "T123", eventId: "EvPI123", textDigest: createHash("sha256").update(ANSWER, "utf8").digest("hex") };
      expect(await native.authorizePublication(request)).toEqual({ allowed: true });
      for (const change of [{ appId: "A999" }, { teamId: "T999" }, { eventId: "EvFORGED" }, { textDigest: "b".repeat(64) },
        { scopeId: "10000000-0000-4000-8000-000000000099" }, { actorId: actors.owner }, { ownerId: actors.editor }]) {
        const allowed = await native.authorizePublication({ ...request, ...change }).then(result => result.allowed === true, () => false);
        expect(allowed).toBe(false);
      }
    });
    expect((await native.platform.routes.request("/webhooks/slack/events", native.signed())).status).toBe(200);
    await native.company.service!.drain();
    await vi.waitFor(async () => {
      expect(await s.db.selectFrom("chat_runs").select("status").execute()).toEqual([{ status: "completed" }, { status: "completed" }]);
    }, { timeout: 10_000 });
    inspect = true;
    await native.company.service!.drain();
    expect(inspect).toBe(false); expect(native.posts).toHaveBeenCalledOnce();
  }, 20_000);

});
