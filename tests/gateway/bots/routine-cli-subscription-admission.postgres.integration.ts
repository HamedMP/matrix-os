import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { chatGptPlanPeerProof, type CanonicalChatModelSelection, type CanonicalCreateChatTurnRequest } from "@matrix-os/contracts";
import { ChatAgentContext, chatContextRequestHash } from "../../../packages/gateway/src/chat/agent-context.js";
import { ChatAgentStore } from "../../../packages/gateway/src/chat/agent-store.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import type { Kysely } from "kysely";
import { CanonicalChatOrchestrator, CanonicalChatOrchestrationError } from "../../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry, type CanonicalChatProviderAdapter } from "../../../packages/gateway/src/chat/provider-adapter.js";
import type { ChatProviderCatalogService } from "../../../packages/gateway/src/chat/provider-catalog.js";
import { createCustomBotChats } from "../../../packages/gateway/src/bots/custom-direct-chat.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { createBotContinuationAdmitter } from "../../../packages/gateway/src/bots/continuations.js";
import { createChatGptPlanPeers } from "../../../packages/gateway/src/bots/chatgpt-plan-peers.js";
import { withChatGptPlanProviderInstance } from "../../../packages/gateway/src/bots/chatgpt-plan-provider-instance.js";
import { withBotProviderInstance } from "../../../packages/gateway/src/bots/provider-instance.js";
import { createRealBotStateDatabase } from "./bot-state-support.js";

const OWNER = { type: "personal" as const, ownerId: "synthetic_subscription_owner" };
const CHAT = "chat_subscription_admission_repro";
const BOT = "bot_ae0000000000000000000001";
const TEXT = "Synthetic admission comparison; never invoke a model.";
const ACCOUNT = "synthetic-subscription-account";
const selected = (accountId = ACCOUNT, grantRevision = "1"): CanonicalChatModelSelection => ({
  instanceId: "matrix_chatgpt_plan", model: "gpt-6-luna",
  options: [{ id: "accountId", value: accountId }, { id: "grantRevision", value: grantRevision }],
});
const EFFECTIVE = { instanceId: "matrix_bot_default", model: "gpt-6-luna",
  options: [{ id: "accountId", value: "synthetic-subscription-account" }, { id: "grantRevision", value: "1" }] };
const CASES = [
  { source: "jwt", kind: "auto" }, { source: "jwt", kind: "concrete" },
  { source: "configured-container", kind: "auto" }, { source: "configured-container", kind: "concrete" },
] as const;
type Case = typeof CASES[number];
let data: Awaited<ReturnType<typeof createRealBotStateDatabase>> | undefined;
let fixture: Awaited<ReturnType<typeof subscriptionFixture>> | undefined;

async function subscriptionFixture(db: NonNullable<typeof data>["db"]) {
  const home = await mkdtemp(join(tmpdir(), "routine-subscription-admission-"));
  let clock = Date.parse("2026-11-06T00:00:00.000Z");
  const now = () => new Date(clock);
  const chats = new ChatRepository(db as unknown as Kysely<ChatDatabase>);
  const agents = new ChatAgentStore({ homePath: home, db: chats.kysely, now });
  await agents.bootstrap();
  await chats.create(OWNER, { id: CHAT, clientRequestId: "req_subscription_chat", title: "Synthetic admission" });
  await agents.createRecipeBot(OWNER, { id: BOT, createHash: "a".repeat(64),
    fields: { name: "Synthetic Bot", description: "", instructions: "Do not invoke tools.", selection: selected() },
    recipeRef: { recipeId: "matrix-bot", version: "2026-10-10.1" } });
  await createBotBindingsRepository(db).bindDirect({ ownerId: OWNER.ownerId, botId: BOT, chatId: CHAT, now: now().toISOString() });
  const peers = createChatGptPlanPeers({ db, ownerId: OWNER.ownerId, computerId: "synthetic-computer", now: () => clock });
  const keys = generateKeyPairSync("ed25519"), der = keys.publicKey.export({ type: "spki", format: "der" });
  const snapshot = { deviceId: createHash("sha256").update(der).digest("hex"), accountId: ACCOUNT, grantRevision: 1,
    enabled: true, background: false, models: [{ id: "gpt-6-luna", displayName: "Synthetic model", input: ["text" as const], contextWindow: 8192, maxOutputTokens: 256 }] };
  const challenge = peers.challenge(OWNER.ownerId);
  await peers.connect(OWNER.ownerId, { version: 1, challenge: challenge.challenge, snapshot,
    publicKey: der.toString("base64url"), signature: sign(null, Buffer.from(chatGptPlanPeerProof({ ...challenge, snapshot })), keys.privateKey).toString("base64url") });
  const context = new ChatAgentContext({ repository: chats, agents, enabled: () => true,
    botChats: createCustomBotChats({ chats, agents }) });
  const preparations = vi.spyOn(context, "prepare"); // Observational spy: production method still runs.
  const projected = withBotProviderInstance(withChatGptPlanProviderInstance({
    // Unrelated harness inventory is empty. The subscription descriptor must
    // come from the real signed peer, not a premanufactured success catalog.
    getCatalog: async () => ({ revision: "unrelated-inventory", drivers: [], instances: [] }),
  }, peers, () => true));
  const catalogs: Array<{ principal: Parameters<ChatProviderCatalogService["getCatalog"]>[0];
    selection?: CanonicalChatModelSelection; catalog: Awaited<ReturnType<ChatProviderCatalogService["getCatalog"]>> }> = [];
  const catalog: Pick<ChatProviderCatalogService, "getCatalog"> = { getCatalog: async (principal, selection) => {
    const result = await projected.getCatalog(principal, selection);
    catalogs.push({ principal, selection, catalog: result });
    return result;
  } };
  const started: CanonicalChatModelSelection[] = [];
  // The fixture ends AFTER production admission. No host adapter, tool,
  // inference broker or account execution is installed or qualified here.
  const adapter: CanonicalChatProviderAdapter = { driverKind: "matrix_bot", stateSchemaVersion: 1,
    parseState: value => value, serializeState: value => value,
    async *start(input) { started.push(input.selection); yield { type: "run.completed", outcome: "completed" }; } };
  const canonical = new CanonicalChatOrchestrator({ repository: chats, agentContext: context, catalog,
    adapters: new CanonicalChatProviderRegistry([adapter]), now });
  const attempts: CanonicalCreateChatTurnRequest[] = [];
  const transport = { admitTurn: async (...args: Parameters<typeof canonical.admitTurn>) => {
    attempts.push(args[3]); return canonical.admitTurn(...args);
  }, enqueueQueuedTurn: canonical.enqueueQueuedTurn.bind(canonical) };
  const continueBot = createBotContinuationAdmitter({ repository: chats, orchestrator: transport });
  return { db, chats, agents, peers, preparations, catalogs, started, attempts, canonical,
    expire: () => { clock += 30_001; },
    save: async (selection: CanonicalChatModelSelection) => {
      const bot = await agents.get(OWNER, BOT);
      if (!bot) throw new Error("Required saved recipe Bot missing");
      await agents.update(OWNER, BOT, { baseRevision: bot.revision, selection });
    },
    admit: async (row: Case, id = `req_${row.source.replaceAll("-", "_")}_${row.kind}`) => {
      const principal = { userId: OWNER.ownerId, source: row.source };
      const saved = await agents.get(OWNER, BOT), chat = await chats.get(OWNER, CHAT);
      if (!saved || !chat) throw new Error("Required owner Bot/Chat fixture missing");
      if (row.kind === "auto") await continueBot(principal, { chatId: CHAT, clientRequestId: id, text: TEXT });
      else await transport.admitTurn(principal, OWNER, CHAT, { clientRequestId: id, baseRevision: chat.chat.revision,
        parts: [{ type: "text", text: TEXT }], selection: { ...saved.selection, instanceId: "matrix_bot_default" },
        interactionMode: "default", permissionMode: "default" });
      await canonical.drain();
      const input = attempts.at(-1)!;
      return { input, hash: chatContextRequestHash(input),
        admission: await chats.findTurnAdmission(OWNER, CHAT, id, chatContextRequestHash(input)) };
    },
    close: async () => { peers.close(); try { await canonical.drain(); await canonical.close(); }
      finally { await agents.close(); await chats.release(); await rm(home, { recursive: true, force: true }); } },
  };
}

beforeEach(async () => {
  const url = process.env.MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL;
  if (!url) throw new Error("MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL is required for subscription admission comparison");
  data = await createRealBotStateDatabase(url);
  fixture = await subscriptionFixture(data.db);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network is outside this isolated admission comparison"); }));
});
afterEach(async () => {
  try { await fixture?.close(); }
  finally { fixture = undefined; await data?.destroy(); data = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); }
});

// Named faults: skipping saved-coordinator preparation for auto, losing its
// account/grant, or discriminating against the trusted internal principal.
it("admits auto and concrete Bot selection for both owner principals against the same real signed subscription snapshot", async () => {
  expect.assertions(47);
  const f = fixture!;
  const saved = await f.agents.get(OWNER, BOT);
  expect(saved).toMatchObject({ archived: false, recipeRef: { recipeId: "matrix-bot", version: "2026-10-10.1" }, selection: selected() });
  expect(await f.peers.observe(OWNER.ownerId)).toMatchObject({ availability: "available", accountId: ACCOUNT,
    models: [{ id: "gpt-6-luna" }], authorization: { revision: 1, enabled: true, background: false } });
  expect(await f.peers.resolve(selected(), OWNER.ownerId, "interactive")).toMatchObject({
    accessSourceId: "matrix_chatgpt_plan", route: { modelId: "gpt-6-luna" },
    subscription: { accountId: "synthetic-subscription-account", computerId: "synthetic-computer", grantRevision: 1 },
  });
  await expect(f.peers.resolve(selected(), OWNER.ownerId, "background")).rejects.toMatchObject({ code: "model_unavailable" });
  const hashes: string[] = [];
  for (const row of CASES) {
    const result = await f.admit(row);
    hashes.push(result.hash);
    expect(result.admission?.run).toMatchObject({ driverKind: "matrix_bot", instanceId: "matrix_bot_default", selection: EFFECTIVE,
      interactionMode: "default", permissionMode: "default" });
    expect(result.admission?.run.context).toBeUndefined();
    expect(await f.preparations.mock.results.at(-1)!.value).toEqual({ selection: EFFECTIVE, interactionMode: "default", permissionMode: "default" });
    const read = f.catalogs.at(-1)!;
    expect(read.principal).toEqual({ userId: OWNER.ownerId, source: row.source });
    expect(read.selection).toEqual(EFFECTIVE);
    expect(read.catalog.instances).toMatchObject([{ id: "matrix_bot_default", availability: "available", supports: { rootChat: true },
      models: [{ id: "gpt-6-luna", availability: "available" }], options: [
        { id: "accountId", values: [{ value: ACCOUNT }] }, { id: "grantRevision", values: [{ value: "1" }] },
      ] }]);
    expect(result.input.selection).toEqual(row.kind === "auto" ? { instanceId: "matrix_bot_default", model: "auto" } : EFFECTIVE);
  }
  expect(hashes[0]).toBe(hashes[2]);
  expect(hashes[1]).toBe(hashes[3]);
  expect(hashes[0]).not.toBe(hashes[1]); // Original intent hash remains distinct from prepared selection.
  for (const row of CASES) expect((await f.admit(row)).admission).not.toBeNull();
  expect(f.catalogs).toHaveLength(4); // Duplicate requests never redo catalog/preparation/dispatch.
  expect(f.preparations).toHaveBeenCalledTimes(4);
  expect(f.started).toEqual([EFFECTIVE, EFFECTIVE, EFFECTIVE, EFFECTIVE]);
  for (const table of ["chat_turns", "chat_runs"] as const) {
    expect(await f.db.selectFrom(table).selectAll().where("chat_id", "=", CHAT).execute()).toHaveLength(4);
  }
  expect(await f.db.selectFrom("chat_queued_turns").selectAll().execute()).toHaveLength(0);
  expect(await f.peers.observe(OWNER.ownerId)).toMatchObject({ authorization: { revision: 1, enabled: true, background: false } });
  expect(fetch).not.toHaveBeenCalled();
});

// Named faults: stale/private binding accepted through auto's fallback, or
// catalog admission fabricated while the current signed peer is unavailable.
it.each([
  { name: "expired peer", code: "provider_unavailable", prepare: async (f: NonNullable<typeof fixture>) => { f.expire(); } },
  { name: "stale saved grant", code: "capability_mismatch", prepare: async (f: NonNullable<typeof fixture>) => { await f.save(selected(ACCOUNT, "0")); } },
  { name: "different saved account", code: "capability_mismatch", prepare: async (f: NonNullable<typeof fixture>) => { await f.save(selected("synthetic-other-account")); } },
])("refuses $name before canonical rows for all four selection/principal pairs", async ({ prepare, code }) => {
  expect.assertions(19);
  const f = fixture!;
  await prepare(f);
  for (const row of CASES) {
    let failure: unknown;
    try { await f.admit(row); } catch (error: unknown) { failure = error; }
    expect(failure).toBeInstanceOf(CanonicalChatOrchestrationError);
    expect((failure as CanonicalChatOrchestrationError).safeError.code).toBe(code);
  }
  expect(f.catalogs).toHaveLength(4);
  expect(f.preparations).toHaveBeenCalledTimes(4);
  expect(f.started).toEqual([]);
  for (const table of ["chat_queued_turns", "chat_turns", "chat_runs", "bot_tasks", "bot_approvals", "bot_routines"] as const) {
    expect(await f.db.selectFrom(table).selectAll().execute()).toHaveLength(0);
  }
  expect((await f.chats.get(OWNER, CHAT))?.chat.messageCount).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
});
