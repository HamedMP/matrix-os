import { afterEach, beforeEach, expect, it } from "vitest";
import { routineActionPolicy } from "../../../packages/gateway/src/bots/routine-action-source-registry.js";
import { fullAccessFixture } from "./routine-full-access-support.js";
import { BOT, OTHER_OWNER, insertChat } from "./bot-state-support.js";

let f: Awaited<ReturnType<typeof fullAccessFixture>>;
beforeEach(async () => { f = await fullAccessFixture(); });
afterEach(async () => { await f.close(); });

it("requires explicit scope consent, a fresh matching turn proof and one actual source generation", async () => {
  expect(await f.service.status(f.principal, f.chatId)).toMatchObject({ revision: 0, eligibility: "eligible", consent: null, challenge: null });
  const { approved } = await f.consent();
  const admitted = await f.admission(approved.consent!.scopeId);
  const release = await f.service.beforeTurnDispatch(admitted);
  const source = f.source(admitted), policy = source.producer.readPolicy();
  expect(policy).toMatchObject({ live: true, originCeiling: "full" });
  expect(routineActionPolicy(source.producer.source, policy, "propose")).toBe("deny");
  expect(routineActionPolicy(source.producer.source, policy, "control")).toBe("allow");
  expect(source.fullAccessTarget).toMatchObject({ botId: BOT, chatId: f.target.chatId, preferenceRevision: 1 });
  expect(await f.db.transaction().execute(trx => source.producer.validateWithin(source.producer.source, trx, "propose"))).toBe(false);
  expect(await f.db.transaction().execute(trx => source.producer.validateWithin(source.producer.source, trx, "control"))).toBe(true);
  expect(f.source(admitted).producer.readPolicy().originCeiling, "A second native source cannot inherit the existing lease").toBe("exact");
  release!(); expect(source.producer.readPolicy().live).toBe(false);
  expect(await f.db.selectFrom("bot_grants").selectAll().execute()).toEqual([]);
  expect(await f.db.selectFrom("bot_routines").selectAll().execute()).toEqual([]);
});

it("never treats mode, scope reference, unsigned decisions or another principal as consent", async () => {
  const created = await f.service.createChallenge(f.principal, f.chatId, { baseRevision: 0 }), challenge = created.challenge!;
  const body = { scopeDigest: challenge.scopeDigest, decision: "approve", clientRequestId: "de000000-0000-4000-8000-000000000002" };
  await expect(f.service.submitDecision({ ...f.principal, userId: OTHER_OWNER }, f.chatId, challenge.challengeId, body, "browser-proof-fixture")).rejects.toMatchObject({ code: "permission_denied" });
  await expect(f.service.submitDecision(f.principal, f.chatId, challenge.challengeId, body, "")).rejects.toMatchObject({ code: "permission_denied" });
  const admitted = await f.admission(challenge.challengeId);
  await f.service.beforeTurnDispatch(admitted);
  expect(f.source(admitted).producer.readPolicy().originCeiling).toBe("exact");
  expect(f.verify).not.toHaveBeenCalled();
});

it("retains the original consent deadline and safely repeats only the same decision", async () => {
  const { approved, created, challenge, decision } = await f.consent(); f.advance(10_000);
  expect(approved.revision, "Approval must invalidate pre-decision status revisions").toBeGreaterThan(created.revision);
  expect(await f.service.submitDecision(f.principal, f.chatId, challenge.challengeId, decision, "browser-proof-fixture")).toEqual(approved);
  await expect(f.service.submitDecision(f.principal, f.chatId, challenge.challengeId, { ...decision, decision: "decline" }, "browser-proof-fixture")).rejects.toMatchObject({ code: "revision_conflict" });
  const admitted = await f.admission(approved.consent!.scopeId); await f.service.beforeTurnDispatch(admitted);
  const source = f.source(admitted); f.advance(30 * 60_000);
  expect(source.producer.readPolicy().live).toBe(false);
  expect(await f.service.status(f.principal, f.chatId)).toMatchObject({ consent: null, challenge: null });
  expect(f.service.bindSource(source.producer.source, source.controller.signal)).toBeNull();
});

it.each(["revoke", "new challenge", "source close", "shutdown"])("invalidates an existing source on %s without restoring authority", async condition => {
  const { approved } = await f.consent(), admitted = await f.admission(approved.consent!.scopeId);
  await f.service.beforeTurnDispatch(admitted); const source = f.source(admitted);
  if (condition === "revoke") await f.service.revoke(f.principal, f.chatId, { baseRevision: approved.revision });
  if (condition === "new challenge") await f.service.createChallenge(f.principal, f.chatId, { baseRevision: approved.revision });
  if (condition === "source close") source.controller.abort();
  if (condition === "shutdown") f.service.close();
  expect(source.producer.readPolicy().live).toBe(false);
  expect(f.source(admitted).producer.readPolicy().originCeiling).toBe("exact");
});

it.each(["supervised", "review", "agent", "retry", "foreign owner", "foreign actor", "other provider"])("does not upgrade a %s Run", async condition => {
  const { approved } = await f.consent(), admitted = await f.admission(approved.consent!.scopeId);
  if (condition === "supervised") admitted.run.permissionMode = "supervised";
  if (condition === "review") admitted.run.interactionMode = "review";
  if (condition === "agent") admitted.run.context = { agent: { id: "fixture" } } as never;
  if (condition === "retry") admitted.run.attempt = 2;
  if (condition === "foreign owner") admitted.owner = { type: "personal", ownerId: OTHER_OWNER };
  if (condition === "foreign actor") admitted.actorId = OTHER_OWNER;
  if (condition === "other provider") admitted.run.driverKind = "codex";
  await f.service.beforeTurnDispatch(admitted);
  expect(f.source(admitted).producer.readPolicy().originCeiling).toBe("exact");
  expect((await f.service.status(f.principal, f.chatId)).consent).toBeNull();
});

it.each(["target reset", "target rebound", "source shared", "source bound", "source archived", "run mode"])("revalidates %s in the actual producer transaction", async condition => {
  const { approved } = await f.consent(), admitted = await f.admission(approved.consent!.scopeId);
  await f.service.beforeTurnDispatch(admitted); const source = f.source(admitted);
  if (condition === "target reset") await f.targets.reset(f.principal, { baseRevision: 1 });
  if (condition === "target rebound") {
    await f.bindings.remove({ ...f.scope, ...f.target, now: new Date().toISOString() });
    await f.bindings.bindDirect({ ...f.scope, ...f.target, now: new Date(Date.now() + 1).toISOString() });
  }
  if (condition === "source shared") await f.db.updateTable("chats").set({ collaboration: { shared: true } }).where("id", "=", f.chatId).execute();
  if (condition === "source bound") await f.bindings.bindGroup({ ownerId: f.scope.ownerId, botId: BOT, chatId: f.chatId, now: new Date().toISOString() });
  if (condition === "source archived") await f.db.updateTable("chats").set({ lifecycle: "archived" }).where("id", "=", f.chatId).execute();
  if (condition === "run mode") await f.db.updateTable("chat_runs").set({ permission_mode: "supervised" }).where("id", "=", admitted.runId).execute();
  expect(await f.db.transaction().execute(trx => source.producer.validateWithin(source.producer.source, trx, "control"))).toBe(false);
  expect(source.producer.readPolicy().live).toBe(false);
});

it("binds fresh proof to the exact request and fails closed when verification becomes unavailable", async () => {
  const { approved } = await f.consent(), admitted = await f.admission(approved.consent!.scopeId);
  await f.service.beforeTurnDispatch(admitted); const source = f.source(admitted);
  const tuple = f.verify.mock.calls.at(-1)![0];
  expect(tuple).toMatchObject({ kind: "turn", chatId: f.chatId, scopeId: approved.consent!.scopeId, clientRequestId: admitted.clientRequestId });
  expect(tuple.kind === "turn" && tuple.requestDigest).toMatch(/^[a-f0-9]{64}$/);
  f.verify.mockRejectedValueOnce(new Error("Fixture proof service unavailable"));
  await expect(f.service.beforeTurnDispatch(admitted)).rejects.toMatchObject({ code: "unavailable" });
  expect(source.producer.readPolicy().live).toBe(false);
});

it.each(["wrong tuple", "expired", "replayed"])("permanently closes an existing lease after a %s turn proof", async fault => {
  const { approved } = await f.consent(), admitted = await f.admission(approved.consent!.scopeId);
  await f.service.beforeTurnDispatch(admitted); const source = f.source(admitted);
  const proof = await f.verify(f.verify.mock.calls.at(-1)![0], "browser-proof-fixture");
  if (fault === "wrong tuple") proof.chatId = "chat_wrong";
  if (fault === "expired") proof.expiresAt -= 60_001;
  if (fault === "replayed") proof.nonce = "1".padStart(32, "0");
  f.verify.mockResolvedValueOnce(proof);
  await expect(f.service.beforeTurnDispatch(admitted)).rejects.toMatchObject({ code: "permission_denied" });
  expect(source.producer.readPolicy().live, "Rejected proof must permanently invalidate the existing lease").toBe(false);
  expect((await f.service.status(f.principal, f.chatId)).consent).toBeNull();
});

it.each(["fresh admission", "duplicate decision"])("permanently closes an existing lease when a %s observes target revision drift", async condition => {
  const { approved, challenge, decision } = await f.consent(), admitted = await f.admission(approved.consent!.scopeId);
  await f.service.beforeTurnDispatch(admitted); const source = f.source(admitted);
  await f.targets.reset(f.principal, { baseRevision: 1 });
  const pending = condition === "fresh admission" ? f.service.beforeTurnDispatch(admitted)
    : f.service.submitDecision(f.principal, f.chatId, challenge.challengeId, decision, "browser-proof-fixture");
  await expect(pending).rejects.toMatchObject({ code: "target_required" });
  expect(source.producer.readPolicy().live, "Admission failure must invalidate the lease before another native use").toBe(false);
});

it("rejects cross-Chat, stale revision, and replayed turn proof", async () => {
  const { approved, challenge, decision } = await f.consent();
  await insertChat(f.db, "chat_other");
  await expect(f.service.submitDecision(f.principal, "chat_other", challenge.challengeId, decision, "browser-proof-fixture")).rejects.toMatchObject({ code: "permission_denied" });
  await expect(f.service.revoke(f.principal, f.chatId, { baseRevision: 0 })).rejects.toMatchObject({ code: "revision_conflict" });
  const admitted = await f.admission(approved.consent!.scopeId); await f.service.beforeTurnDispatch(admitted);
  f.setNonce(1);
  await expect(f.service.beforeTurnDispatch(admitted)).rejects.toMatchObject({ code: "permission_denied" });
  expect((await f.service.status(f.principal, f.chatId)).consent).toBeNull();
});

it("rejects a wrong proof purpose without leaving scope consent live", async () => {
  const { approved } = await f.consent(), next = await f.admission(approved.consent!.scopeId);
  f.verify.mockImplementationOnce(async tuple => ({ ...tuple, purpose: "routine_cli_owner_action" } as never));
  await expect(f.service.beforeTurnDispatch(next)).rejects.toMatchObject({ code: "unavailable" });
  expect((await f.service.status(f.principal, f.chatId)).consent).toBeNull();
});

it.each(["request mode", "request selection", "admitted Chat", "admitted Turn"])("rejects inconsistent %s at the private admission port", async condition => {
  const { approved } = await f.consent(), admitted = await f.admission(approved.consent!.scopeId);
  if (condition === "request mode") admitted.body.permissionMode = "supervised";
  if (condition === "request selection") admitted.body.selection = { ...admitted.body.selection, model: "other-model" };
  if (condition === "admitted Chat") admitted.run.chatId = "chat_different";
  if (condition === "admitted Turn") admitted.run.turnId = "cturn_different";
  await f.service.beforeTurnDispatch(admitted);
  expect(f.source(admitted).producer.readPolicy().originCeiling).toBe("exact");
});

it("retains observed verifier unavailability until an explicit fresh proof succeeds", async () => {
  const { approved } = await f.consent(), admitted = await f.admission(approved.consent!.scopeId);
  f.verify.mockRejectedValueOnce(new Error("Fixture verifier unavailable"));
  await expect(f.service.beforeTurnDispatch(admitted)).rejects.toMatchObject({ code: "unavailable" });
  const status = await f.service.status(f.principal, f.chatId);
  expect(status).toMatchObject({ eligibility: "unavailable", consent: null, challenge: null });
  const next = await f.service.createChallenge(f.principal, f.chatId, { baseRevision: status.revision });
  expect(next.eligibility).toBe("unavailable"); expect(next.challenge).not.toBeNull();
  const challenge = next.challenge!;
  expect(await f.service.submitDecision(f.principal, f.chatId, challenge.challengeId,
    { scopeDigest: challenge.scopeDigest, decision: "approve", clientRequestId: "de000000-0000-4000-8000-000000000010" }, "browser-proof-fixture"))
    .toMatchObject({ eligibility: "eligible", consent: { scopeId: challenge.challengeId } });
});

it("bounds Chat scope memory and evicts expired revoked entries without restoring consent", async () => {
  await f.close(); f = await fullAccessFixture(undefined, { maxScopes: 1 });
  const { approved } = await f.consent(); await insertChat(f.db, "chat_second");
  await expect(f.service.createChallenge(f.principal, "chat_second", { baseRevision: 0 })).rejects.toMatchObject({ code: "unavailable" });
  await f.service.revoke(f.principal, f.chatId, { baseRevision: approved.revision });
  await expect(f.service.createChallenge(f.principal, "chat_second", { baseRevision: 0 })).rejects.toMatchObject({ code: "unavailable" });
  f.advance(30 * 60_000);
  expect(await f.service.createChallenge(f.principal, "chat_second", { baseRevision: 0 })).toMatchObject({ consent: null, challenge: { target: { botId: BOT } } });
  expect(await f.service.status(f.principal, f.chatId)).toMatchObject({ consent: null, challenge: null });
});

it("bounds fresh Run leases independently of the scope count and releases them on source closure", async () => {
  await f.close(); f = await fullAccessFixture(undefined, { maxRunLeases: 1 });
  const first = await f.consent(), admitted = await f.admission(first.approved.consent!.scopeId);
  await f.service.beforeTurnDispatch(admitted); const source = f.source(admitted);
  await insertChat(f.db, "chat_second"); const second = await f.consent("chat_second");
  const other = await f.admission(second.approved.consent!.scopeId, {}, "chat_second");
  await expect(f.service.beforeTurnDispatch(other)).rejects.toMatchObject({ code: "unavailable" });
  expect(f.source(other).producer.readPolicy().originCeiling).toBe("exact");
  source.controller.abort(); expect(source.producer.readPolicy().live).toBe(false);
});

it.each(["revoke", "new challenge"])("rejects a late verified decision after %s during the network wait", async change => {
  const created = await f.service.createChallenge(f.principal, f.chatId, { baseRevision: 0 }), challenge = created.challenge!;
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), actual = f.verify.getMockImplementation()!;
  f.verify.mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; return actual(...args); });
  const pending = f.service.submitDecision(f.principal, f.chatId, challenge.challengeId,
    { scopeDigest: challenge.scopeDigest, decision: "approve", clientRequestId: "de000000-0000-4000-8000-000000000020" }, "browser-proof-fixture");
  void pending.catch(() => undefined);
  try {
    await entered.promise;
    if (change === "revoke") await f.service.revoke(f.principal, f.chatId, { baseRevision: created.revision });
    else await f.service.createChallenge(f.principal, f.chatId, { baseRevision: created.revision });
    release.resolve(); await expect(pending).rejects.toMatchObject({ code: "permission_denied" });
    expect((await f.service.status(f.principal, f.chatId)).consent).toBeNull();
  } finally { release.resolve(); await Promise.allSettled([pending]); }
});
