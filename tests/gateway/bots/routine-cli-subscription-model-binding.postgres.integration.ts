import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { chatGptPlanPeerProof, type CanonicalChatModelSelection } from "@matrix-os/contracts";
import { createChatGptPlanPeers } from "../../../packages/gateway/src/bots/chatgpt-plan-peers.js";
import { withChatGptPlanProviderInstance } from "../../../packages/gateway/src/bots/chatgpt-plan-provider-instance.js";
import { createBotRecipeCatalog } from "../../../packages/gateway/src/bots/recipe-catalog.js";
import { RoutineCliError } from "../../../packages/gateway/src/bots/routine-cli-errors.js";
import { assertRoutineCliProposalBinding } from "../../../packages/gateway/src/bots/routine-cli-proposal-runtime.js";
import { createRoutineCliRequestsRepository } from "../../../packages/gateway/src/bots/repositories/routine-cli-requests.js";
import type { BotRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { createRealBotStateDatabase, BOT, OWNER, NOW } from "./bot-state-support.js";
import { proposalFixture } from "./routine-cli-proposal-support.js";
import { proposal, scope, TARGET_A } from "./routine-cli-request-support.js";

const REQUEST = "de000000-0000-4000-8000-000000000771";
const OPTIONS = [{ id: "accountId", value: "synthetic-model-binding-account" }, { id: "grantRevision", value: "1" }];
const SAVED: CanonicalChatModelSelection = { instanceId: "matrix_chatgpt_plan", model: "gpt-6-luna", options: OPTIONS };
const WARNING = "[routine-cli-proposals] Proposal outcome requires reconciliation";
let data: Awaited<ReturnType<typeof createRealBotStateDatabase>> | undefined;
let f: Awaited<ReturnType<typeof proposalFixture>> | undefined;
let peers: ReturnType<typeof createChatGptPlanPeers> | undefined;

beforeEach(async () => {
  const url = process.env.MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL;
  if (!url) throw new Error("MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL is required for real subscription model-binding reproduction");
  data = await createRealBotStateDatabase(url);
  peers = createChatGptPlanPeers({ db: data.db, ownerId: OWNER, computerId: scope.computerId,
    now: () => Date.parse(f?.state.clock ?? NOW),
    authorizeRoutine: async () => { throw new Error("No approved occurrence or inference is allowed in this proposal-only test"); } });
  const keys = generateKeyPairSync("ed25519"), der = keys.publicKey.export({ type: "spki", format: "der" });
  const snapshot = { deviceId: createHash("sha256").update(der).digest("hex"), accountId: "synthetic-model-binding-account",
    grantRevision: 1, enabled: true, background: false,
    models: ["gpt-6-luna", "gpt-6.1-sol"].map(id => ({ id, displayName: "Synthetic model", input: ["text" as const], contextWindow: 8192, maxOutputTokens: 256 })) };
  const challenge = peers.challenge(OWNER);
  const session = await peers.connect(OWNER, { version: 1, challenge: challenge.challenge, snapshot,
    publicKey: der.toString("base64url"), signature: sign(null, Buffer.from(chatGptPlanPeerProof({ ...challenge, snapshot })), keys.privateKey).toString("base64url") });
  // Real protocol negotiation permits approval-scoped routine resolution; it
  // never enables broad background permission or authorizes an occurrence.
  expect(peers.capabilities(OWNER, session, false, false, true)).toMatchObject({ approvedRoutines: true });
  const catalog = withChatGptPlanProviderInstance({ getCatalog: async () => ({ revision: "unrelated-inventory", drivers: [], instances: [] }) }, peers, () => true);
  f = await proposalFixture(data.db, vi.fn, { adapters: [], catalog: { revision: "unused", drivers: [], instances: [] }, catalogService: catalog,
    recipe: createBotRecipeCatalog().resolve({ recipeId: "matrix-bot", version: "2026-10-10.1" }) });
  const bot = await f.agents.get({ type: "personal", ownerId: OWNER }, BOT);
  if (!bot) throw new Error("Required ordinary saved Bot missing");
  await f.agents.update({ type: "personal", ownerId: OWNER }, BOT, { baseRevision: bot.revision, selection: SAVED });
  f.policy.background = false; // Old permissive fixture route is never used.
  f.hooks.resolveRoutineSource = peers.resolve;
  f.taskDependencies.resolveRoute = (selection, requestClass = "interactive") => {
    if (!selection) throw new Error("Real saved coordinator selection required");
    return peers!.resolve(selection, OWNER, requestClass);
  };
  f.taskDependencies.assertSource = async (binding, signal) => {
    if (!await peers!.revalidate(binding, signal)) throw new Error("Current signed peer binding required");
  };
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network execution is outside this isolated proposal test"); }));
});
afterEach(async () => {
  peers?.close(); peers = undefined;
  try { await f?.close(); }
  finally { f = undefined; await data?.destroy(); data = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); }
});

// Named fault/reproduction: a proposal accepted for one model reaches a real
// runtime for the saved different model; the necessary guard must refuse it.
// Match control uses the identical real admission/registry/approval boundary.
it.each([
  { model: "gpt-6-luna", matched: true },
  { model: "gpt-6.1-sol", matched: false },
])("compares proposed $model with the actual saved Luna binding without inference or fabricated route", async ({ model, matched }) => {
  const x = f!, authority = peers!;
  await expect(authority.resolve(SAVED, OWNER, "background")).rejects.toMatchObject({ code: "model_unavailable" });
  expect(await authority.resolve({ ...SAVED, model }, OWNER, "routine")).toMatchObject({ route: { modelId: model } });
  const consume = x.proposals.consume;
  const observations: Array<{ binding: BotRuntimeBinding; claimedRevision: number; guardError?: unknown; consumeError?: unknown }> = [];
  x.proposals.consume = async (binding, signal) => {
    const receipt = await createRoutineCliRequestsRepository(x.db).get(scope, REQUEST);
    const dispatch = await x.db.selectFrom("routine_cli_proposals").selectAll().where("client_request_id", "=", REQUEST).executeTakeFirstOrThrow();
    if (!receipt) throw new Error("Required immutable proposal receipt missing");
    expect(x.registry.lookupRun(binding)).toEqual(binding);
    expect({ signal: signal.aborted, inference: x.registry.inferenceSignal(binding)?.aborted,
      group: binding.group, requestClass: binding.requestClass, capability: binding.capabilities.includes("routine.propose"),
      owner: binding.ownerId === receipt.target.ownerId, bot: binding.botId === receipt.target.botId, chat: binding.chatId === receipt.target.chatId,
      run: binding.runId === dispatch.run_id, task: binding.taskId === dispatch.task_id,
      source: binding.accessSourceId, computer: binding.subscription?.computerId === receipt.target.computerId,
    }).toEqual({ signal: false, inference: false, group: undefined, requestClass: "interactive", capability: true,
      owner: true, bot: true, chat: true, run: true, task: true, source: "matrix_chatgpt_plan", computer: true });
    const observed: typeof observations[number] = { binding: structuredClone(binding), claimedRevision: Number(dispatch.revision) };
    observations.push(observed);
    // Read-only probe of the actual guard with the real registry/receipt.
    // No altered binding, fake code or replaced validation is supplied.
    try { assertRoutineCliProposalBinding(x.registry, binding, receipt, dispatch, signal); }
    catch (error: unknown) { observed.guardError = error; }
    try { return await consume(binding, signal); }
    catch (error: unknown) { observed.consumeError = error; throw error; }
  };
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const operation = { operation: "propose" as const, requestId: REQUEST, proposal: { ...proposal,
    name: "Synthetic model-binding comparison", prompt: "Reply only with a synthetic marker.",
    selection: { instanceId: "matrix_chatgpt_plan" as const, model } } };
  const initial = await x.submit(operation);
  await x.canonical.drain();
  expect(initial).toMatchObject({ receipt: { disposition: "queued", revision: 1 } });
  expect(observations).toHaveLength(1);
  expect(observations[0]!.binding).toMatchObject({ route: { modelId: "gpt-6-luna" },
    subscription: { accountId: "synthetic-model-binding-account", computerId: scope.computerId, grantRevision: 1 } });
  const dispatch = await x.db.selectFrom("routine_cli_proposals").selectAll().where("client_request_id", "=", REQUEST).executeTakeFirstOrThrow();
  const receipt = await x.db.selectFrom("routine_cli_requests").selectAll().executeTakeFirstOrThrow();
  expect(receipt.operation).toEqual(operation);
  const admitted = await x.chats.findTurnAdmission({ type: "personal", ownerId: OWNER }, TARGET_A.chatId, dispatch.canonical_request_id, dispatch.request_hash);
  expect(admitted?.run).toMatchObject({ driverKind: "matrix_bot", instanceId: "matrix_bot_default",
    selection: { ...SAVED, instanceId: "matrix_bot_default" }, status: matched ? "completed" : "failed" });
  expect(dispatch).toMatchObject({ run_id: admitted!.run.id, interaction_id: matched ? expect.any(String) : null,
    stage: matched ? "pending_approval" : "target_task_claimed" });
  // Canonical ACK and task claim can race. Compare to the real claimed row,
  // rather than assuming the optional canonical_accepted write was skipped.
  expect(Number(dispatch.revision)).toBe(observations[0]!.claimedRevision + (matched ? 1 : 0));
  expect(await x.execute({ operation: "request", requestId: REQUEST })).toMatchObject({ receipt: { disposition: "queued", revision: 1 },
    proposal: { handoff: matched ? "pending_approval" : "rejected", approval: matched ? "pending" : null, routine: null } });
  expect(await x.db.selectFrom("bot_tasks").select("status").execute()).toEqual([{ status: matched ? "waiting_person" : "failed" }]);
  for (const table of ["bot_interactions", "bot_approvals"] as const) expect(await x.db.selectFrom(table).selectAll().execute()).toHaveLength(matched ? 1 : 0);
  expect(await x.db.selectFrom("chat_outbox").selectAll().where("event_type", "=", "interaction.requested").execute()).toHaveLength(matched ? 1 : 0);
  expect(await x.db.selectFrom("bot_routines").selectAll().execute()).toHaveLength(0);
  if (matched) {
    expect(observations[0]!.guardError).toBeUndefined();
    expect(observations[0]!.consumeError).toBeUndefined();
    expect(warn.mock.calls.filter(([label]) => label === WARNING)).toHaveLength(0);
  } else {
    expect(observations[0]!.guardError).toBeInstanceOf(RoutineCliError);
    expect(observations[0]!.guardError).toMatchObject({ code: "permission_denied" });
    expect(observations[0]!.consumeError).toBeInstanceOf(RoutineCliError);
    expect(observations[0]!.consumeError).toMatchObject({ code: "permission_denied" });
    expect(warn.mock.calls.filter(([label]) => label === WARNING)).toEqual([[WARNING, "RoutineCliError"]]);
  }
  const before = await x.db.selectFrom("routine_cli_proposals").selectAll().executeTakeFirstOrThrow();
  await x.submit(operation); await x.canonical.drain();
  expect(await x.db.selectFrom("routine_cli_proposals").selectAll().executeTakeFirstOrThrow()).toEqual(before);
  expect(observations).toHaveLength(1);
  expect(vi.mocked(x.runBot).mock.calls.filter(([input]) => input.command.kind === "bot.run")).toHaveLength(0);
  expect(x.host.createRuntime).toHaveBeenCalledTimes(1);
  expect(await authority.observe(OWNER)).toMatchObject({ authorization: { revision: 1, enabled: true, background: false } });
  expect(fetch).not.toHaveBeenCalled();
});
