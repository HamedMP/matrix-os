import { generateKeyPairSync, createHash, sign } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { chatGptPlanPeerProof, RoutineCliResultSchema } from "@matrix-os/contracts";
import { createChatGptPlanPeers } from "../../../packages/gateway/src/bots/chatgpt-plan-peers.js";
import { createRealBotStateDatabase, OWNER } from "./bot-state-support.js";
import { proposalFixture } from "./routine-cli-proposal-support.js";
import { proposal, scope } from "./routine-cli-request-support.js";

let data: Awaited<ReturnType<typeof createRealBotStateDatabase>>;
let f: Awaited<ReturnType<typeof proposalFixture>>;
let peers: ReturnType<typeof createChatGptPlanPeers>;
let session: Awaited<ReturnType<typeof peers.connect>>;
const requestId = "de000000-0000-4000-8000-000000000100";

beforeEach(async () => {
  const url = process.env.MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL;
  if (!url) throw new Error("MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL is required for composed ENG93 authority/transaction qualification");
  data = await createRealBotStateDatabase(url);
  f = await proposalFixture(data.db, vi.fn);
  peers = createChatGptPlanPeers({ db: data.db, ownerId: OWNER, computerId: scope.computerId,
    authorizeRoutine: async () => { throw new Error("No approved occurrence is admitted by this proposal-only fixture"); } });
  const keys = generateKeyPairSync("ed25519"), der = keys.publicKey.export({ type: "spki", format: "der" });
  const snapshot = { deviceId: createHash("sha256").update(der).digest("hex"), accountId: "fixture-account", grantRevision: 1,
    enabled: true, background: false, models: [{ id: proposal.selection.model, displayName: "Fixture model", input: ["text" as const], contextWindow: 8192, maxOutputTokens: 256 }] };
  const challenge = peers.challenge(OWNER);
  session = await peers.connect(OWNER, { version: 1, challenge: challenge.challenge, snapshot, publicKey: der.toString("base64url"),
    signature: sign(null, Buffer.from(chatGptPlanPeerProof({ ...challenge, snapshot })), keys.privateKey).toString("base64url") });
  expect(peers.capabilities(OWNER, session, false, false, true)).toMatchObject({ approvedRoutines: true });
  f.hooks.resolveRoutineSource = peers.resolve;
  f.taskDependencies.resolveRoute = () => peers.resolve({ ...proposal.selection,
    options: [{ id: "accountId", value: "fixture-account" }, { id: "grantRevision", value: "1" }] }, OWNER, "interactive");
});
afterEach(async () => { peers?.close(); try { await f?.close(); } finally { await data?.destroy(); } });

// Named fault: requiring broad background source resolution discards a valid negotiated routine proposal.
it("commits the negotiated background-off proposal, exact sourceRunId, approval, waiting task and outbox together", async () => {
  await f.submit(); await f.canonical.drain();
  const result = await f.execute({ operation: "request", requestId });
  expect(result).toMatchObject({ receipt: { disposition: "queued" }, proposal: { handoff: "pending_approval", approval: "pending", routine: null } });
  expect((await peers.observe(OWNER)).authorization).toMatchObject({ background: false, revision: 1 });
  const task = await f.db.selectFrom("bot_tasks").selectAll().executeTakeFirstOrThrow();
  const interaction = await f.db.selectFrom("bot_interactions").selectAll().executeTakeFirstOrThrow();
  const approval = await f.db.selectFrom("bot_approvals").selectAll().executeTakeFirstOrThrow();
  expect(task.status).toBe("waiting_person");
  expect(interaction).toMatchObject({ task_id: task.task_id, source_run_id: task.run_id });
  expect(approval).toMatchObject({ approval_id: interaction.interaction_id, task_id: task.task_id, run_id: task.run_id });
  expect(await f.db.selectFrom("chat_outbox").selectAll().where("event_type", "=", "interaction.requested").execute()).toHaveLength(1);
  expect(await f.db.selectFrom("routine_cli_requests").selectAll().execute()).toHaveLength(1);
  expect(await f.db.selectFrom("bot_routines").selectAll().execute()).toHaveLength(0);
  expect(await f.db.selectFrom("bot_grants").selectAll().execute()).toHaveLength(0);
  expect(vi.mocked(f.runBot).mock.calls.filter(([input]) => input.command.kind === "bot.run")).toHaveLength(0);
});

// Named fault: nesting A.propose's transaction would leak approval/outbox on B's final authority failure.
it("rolls negotiated approval and outbox back after postwrite source revocation, retaining only the admission receipt", async () => {
  const real = f.approvals.proposeWithin; let observed = false;
  f.approvals.proposeWithin = (tx, binding, raw) => real({ ...tx, publish: async (...args) => {
    await tx.publish(...args);
    if (args[1] === "interaction.requested") {
      expect(await tx.db.selectFrom("bot_approvals").selectAll().execute()).toHaveLength(1);
      expect(await f.db.selectFrom("bot_approvals").selectAll().execute()).toHaveLength(0);
      observed = true; peers.disconnect(OWNER, session);
    }
  } }, binding, raw);
  await f.submit(); await f.canonical.drain();
  expect(observed).toBe(true);
  expect(await f.db.selectFrom("bot_interactions").selectAll().execute()).toHaveLength(0);
  expect(await f.db.selectFrom("bot_approvals").selectAll().execute()).toHaveLength(0);
  expect(await f.db.selectFrom("chat_outbox").selectAll().where("event_type", "=", "interaction.requested").execute()).toHaveLength(0);
  expect(await f.db.selectFrom("bot_tasks").select("status").execute()).toEqual([{ status: "failed" }]);
  expect(await f.db.selectFrom("routine_cli_requests").selectAll().execute()).toHaveLength(1);
  expect(await f.execute({ operation: "request", requestId })).toMatchObject({ receipt: { disposition: "queued" }, proposal: { handoff: "rejected", routine: null } });
});

// Named fault: editing replaces approval_id; the old receipt must state that the current link is unavailable.
it("keeps original admission and approved history truthful after an owner-approved edit replaces the routine approval", async () => {
  await f.submit(); await f.canonical.drain();
  const original = await f.db.selectFrom("bot_interactions").selectAll().executeTakeFirstOrThrow();
  await f.interactions.resolve(OWNER, original.chat_id, original.interaction_id,
    { kind: "approval", decision: "approve", baseRevision: Number(original.revision) });
  const before = await f.execute({ operation: "request", requestId });
  const receiptRow = await f.db.selectFrom("routine_cli_requests").selectAll().executeTakeFirstOrThrow();
  const routine = await f.db.selectFrom("bot_routines").selectAll().executeTakeFirstOrThrow();
  expect(before).toMatchObject({ proposal: { approval: "approved", routine: { routineId: routine.routine_id, status: "active", revision: 1 } } });
  const edit = await f.approvals.requestEdit(OWNER, routine.routine_id,
    { baseRevision: Number(routine.revision), name: "Owner revised schedule", prompt: "Read revised approved fixtures", schedule: { kind: "interval", everyMs: 120000 } });
  await f.interactions.resolve(OWNER, original.chat_id, edit.interaction.interactionId,
    { kind: "approval", decision: "approve", baseRevision: edit.interaction.revision });
  const after = await f.execute({ operation: "request", requestId });
  expect(RoutineCliResultSchema.parse(after)).toMatchObject({ receipt: before.kind === "receipt" ? before.receipt : undefined,
    proposal: { approval: "approved", routine: null, routineLink: "unavailable" } });
  expect(await f.db.selectFrom("routine_cli_requests").selectAll().executeTakeFirstOrThrow()).toEqual(receiptRow);
  expect(await f.db.selectFrom("bot_routines").selectAll().execute()).toMatchObject([
    { routine_id: routine.routine_id, status: "active", revision: "2", approval_id: edit.interaction.interactionId,
      proposal: { name: "Owner revised schedule", schedule: { kind: "interval", everyMs: 120000 } } },
  ]);
  expect(await f.db.selectFrom("bot_approvals").selectAll().where("approval_id", "=", original.interaction_id).executeTakeFirstOrThrow()).toMatchObject({ status: "approved" });
  expect((await peers.observe(OWNER)).authorization).toMatchObject({ background: false });
  expect(vi.mocked(f.runBot).mock.calls.filter(([input]) => input.command.kind === "bot.run")).toHaveLength(0);
});
