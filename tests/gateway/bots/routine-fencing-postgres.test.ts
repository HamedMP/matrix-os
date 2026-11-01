import { generateKeyPairSync, createHash, sign } from "node:crypto";
import { chatGptPlanPeerProof } from "@matrix-os/contracts";
import { createChatGptPlanPeers } from "../../../packages/gateway/src/bots/chatgpt-plan-peers.js";
/** Real-PG persisted fencing tests, NOT a real device/worker/model qualification.
 * External subscription/file authority is a controlled double; DB policy/approval/fire/task is real.
 * This suite has not been run in the database-free preparation phase.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { sql } from "kysely";
import { createBotInteractionService } from "../../../packages/gateway/src/bots/interactions.js";
import { createBotInteractionsRepository } from "../../../packages/gateway/src/bots/repositories/interactions.js";
import { createBotRoutinesRepository } from "../../../packages/gateway/src/bots/repositories/routines.js";
import { createBotIntegrationTools } from "../../../packages/gateway/src/bots/integration-tools.js";
import { createBotGrantsRepository } from "../../../packages/gateway/src/bots/repositories/grants.js";
import { createBotRecipeCatalog } from "../../../packages/gateway/src/bots/recipe-catalog.js";
import { createBotRoutineExecution } from "../../../packages/gateway/src/bots/routine-execution.js";
import type { BotToolRequest } from "@matrix-os/contracts";
import { CanonicalChatOrchestrator } from "../../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry } from "../../../packages/gateway/src/chat/provider-adapter.js";
import { BOT, OWNER, PG_AT, PG_CHAT, PG_LATER, PG_NEXT, backendPid, barrier, bounded, expectBlocked, createPgRoutineFixture, pgEnabled, type PgRoutineFixture } from "./routine-postgres-support.js";
const read: BotToolRequest = {
  toolCallId: "call_pg_read",
  capability: "artifact.read",
  args: {
    relPath: "fixture.txt"
  }
};
const write: BotToolRequest = {
  toolCallId: "call_pg_write",
  capability: "artifact.write",
  args: {
    relPath: "fixture.txt",
    content: "must not publish",
    mimeType: "text/plain"
  }
};
describe.skipIf(!pgEnabled)("old routine binding fencing on pooled PostgreSQL (requires dedicated test DB)", () => {
  let f: PgRoutineFixture | undefined;
  beforeEach(async () => {
    f = await createPgRoutineFixture();
  });
  afterEach(async () => {
    await f?.destroy();
    f = undefined;
  });
  it.each(["failed", "uncertain"] as const)("rejects a %s scheduled turn at ordinary Retry admission and fences a previously admitted retry", async status => {
    const fixture = f!, fire = await fixture.claim(), run = await fixture.running(fire.fireId);
    const owner = run.input.owner;
    const original = (await fixture.chats.exportChat(owner, PG_CHAT))!;
    const turn = original.turns[0], first = original.runs[0];
    await fixture.repo.finish({ ownerId: OWNER, fireId: fire.fireId, status, now: PG_AT });
    await fixture.chats.finishRun(owner, { chatId: PG_CHAT, runId: first.id, outcome: "failed", completedAt: PG_AT });
    const before = (await fixture.chats.exportChat(owner, PG_CHAT))!;
    const beforeTasks = await fixture.db.selectFrom("bot_tasks").select("task_id").orderBy("task_id").execute();
    let providerLookups = 0;
    const canonical = new CanonicalChatOrchestrator({ repository: fixture.chats,
      catalog: { getCatalog: async () => { providerLookups++; throw new Error("Scheduled Retry crossed provider boundary"); } },
      adapters: new CanonicalChatProviderRegistry([]) });
    try {
      await expect(canonical.retryTurn({ userId: OWNER, source: "jwt" }, owner, PG_CHAT, turn.id,
        { clientRequestId: "req_pg_manual_retry", baseRevision: before.chat.chat.revision }))
        .rejects.toMatchObject({ status: 409, safeError: { retryable: false, recoveryActions: [] } });
      expect(providerLookups).toBe(0);
      expect(await fixture.chats.exportChat(owner, PG_CHAT)).toEqual(before);
    } finally { await canonical.close(); }
    const retry = await fixture.chats.admitRetry(owner, { chatId: PG_CHAT, turnId: turn.id,
      clientRequestId: "req_pg_existing_retry", baseRevision: before.chat.chat.revision,
      run: { ...first, id: "run_pg_existing_retry", attempt: 2, status: "accepted" } });
    await expect(fixture.execution().prepareRun({ owner, chatId: PG_CHAT, runId: retry.run.id }))
      .rejects.toMatchObject({ code: "not_granted" });
    expect(await fixture.db.selectFrom("bot_tasks").select("task_id").orderBy("task_id").execute()).toEqual(beforeTasks);
    expect((await fixture.repo.getFire(OWNER, fire.fireId))?.status).toBe(status);
  });
  it.each([11, 13])("hands a proven unstarted admission a fresh lease after %s minutes without renewing running work", async minutes => {
    const fixture = f!, fire = await fixture.claim();
    const run = await fixture.running(fire.fireId, { startTask: false });
    const at = new Date(Date.parse(PG_AT) + minutes * 60000).toISOString();
    fixture.setClock(at); const execution = fixture.execution();
    expect(await execution.prepareRun(run.input)).toMatchObject({ backgroundTaskId: fire.taskId });
    const expires = new Date(Date.parse(at) + 12 * 60000).toISOString();
    expect((await fixture.repo.getFire(OWNER, fire.fireId))?.leaseExpiresAt).toBe(expires);
    const task = (await fixture.tasks.get({ ownerId: OWNER, taskId: fire.taskId }))!;
    await fixture.tasks.transition({ ownerId: OWNER, taskId: fire.taskId, baseRevision: task.revision, to: "running", runId: run.input.runId, now: at });
    fixture.setClock(new Date(Date.parse(at) + 2 * 60000).toISOString());
    await expect(execution.assertBinding(run.binding)).resolves.toBeDefined();
    await expect(execution.prepareRun(run.input)).rejects.toMatchObject({ code: "not_granted" });
    fixture.setClock(new Date(Date.parse(at) + 13 * 60000).toISOString());
    await expect(execution.assertBinding(run.binding)).rejects.toMatchObject({ code: "not_granted" });
    await fixture.recover(execution);
    expect((await fixture.repo.getFire(OWNER, fire.fireId))?.status).toBe("uncertain");
    await expect(fixture.execution().prepareRun(run.input)).rejects.toMatchObject({ code: "not_granted" });
  });
  it("serializes an already authorized question waiting on owner capacity with terminal cleanup", async () => {
    const fixture = f!, fire = await fixture.claim(), run = await fixture.running(fire.fireId);
    const creatorEntered = barrier<number>(), finisherEntered = barrier<number>();
    const service = createBotInteractionService({ now: () => new Date(PG_AT), transact: (owner, work) =>
      fixture.transact(owner, async tx => { creatorEntered.resolve(await backendPid(tx.db as typeof fixture.db)); return work(tx); }) });
    const execution = fixture.execution((owner, work) => fixture.transact(owner, async tx => {
      finisherEntered.resolve(await backendPid(tx.db as typeof fixture.db)); return work(tx);
    }));
    let creating: Promise<unknown> | undefined, finishing: Promise<unknown> | undefined;
    let finished = false;
    try {
      await fixture.db.transaction().execute(async holder => {
        const holderPid = await backendPid(holder);
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`bot-interactions:${OWNER}`}, 0))`.execute(holder);
        creating = service.createFromTool(run.binding, { blocking: true,
          payload: { kind: "question", questions: [{ questionId: "late", header: "Fixture", question: "Which fixture?", allowOther: true, secret: false }] } });
        const creatorPid = await bounded(creatorEntered.promise);
        await expectBlocked(fixture.db, creatorPid, holderPid);
        finishing = execution.completeRun(run.input, { status: "failed" }).finally(() => { finished = true; });
        const finisherPid = await bounded(finisherEntered.promise);
        // Establish an actual DB interleaving: either the unfenced finisher commits,
        // or it waits for the creator's task fence. No sleep alone proves ordering.
        let observed = false;
        for (let pass = 0; pass < 100; pass++) {
          const row = (await sql<{ pids: number[] }>`SELECT pg_blocking_pids(${finisherPid}) AS pids`.execute(fixture.db)).rows[0]!;
          if (finished || row.pids.includes(creatorPid)) { observed = true; break; }
          await delay(10);
        }
        expect(observed).toBe(true);
      });
    } finally { await Promise.allSettled([creating, finishing].filter((value): value is Promise<unknown> => Boolean(value))); }
    await creating; await finishing;
    expect((await fixture.repo.getFire(OWNER, fire.fireId))?.status).toBe("failed");
    expect(await createBotInteractionsRepository(fixture.db).listPending({ ownerId: OWNER, chatId: PG_CHAT, now: PG_AT })).toEqual([]);
    const requested = await fixture.db.selectFrom("chat_outbox").select("cursor").where("event_type", "=", "interaction.requested").execute();
    const resolved = await fixture.db.selectFrom("chat_outbox").select("cursor").where("event_type", "=", "interaction.resolved").execute();
    // Initial routine approval is resolved too; both requests end with a resolution.
    expect(resolved).toHaveLength(requested.length);
    await expect(service.createFromTool(run.binding, { blocking: true,
      payload: { kind: "question", questions: [{ questionId: "later", header: "Fixture", question: "Too late?", allowOther: true, secret: false }] } }))
      .rejects.toMatchObject({ code: "stale_generation" });
  });
  it("authorizes the live approved read but never permits an unapproved write", async () => {
    const fixture = f!,
      fire = await fixture.claim(),
      run = await fixture.running(fire.fireId),
      execution = fixture.execution();
    await expect(execution.assertTool(run.binding, read)).resolves.toBeUndefined();
    let published = 0;
    await expect((async () => {
      await execution.assertTool(run.binding, write);
      published++;
    })()).rejects.toMatchObject({
      code: "not_granted"
    });
    expect(published).toBe(0);
    expect((await fixture.repo.getFire(OWNER, fire.fireId))?.status).toBe("dispatched");
  });
  it("a committed pause fences the still-running old binding before cancellation or lease expiry", async () => {
    const fixture = f!,
      fire = await fixture.claim(),
      run = await fixture.running(fire.fireId),
      execution = fixture.execution();
    await execution.assertBinding(run.binding);
    await fixture.db.connection().execute(async writer => {
      const writerPid = await backendPid(writer);
      await writer.transaction().execute(async tx => {
        const repo = createBotRoutinesRepository(tx),
          current = (await repo.get(OWNER, fixture.routine.routineId))!;
        await repo.control({
          ownerId: OWNER,
          routineId: current.routineId,
          baseRevision: current.revision,
          status: "paused",
          now: PG_AT
        });
      });
      await fixture.db.transaction().execute(async reader => {
        expect(await backendPid(reader)).not.toBe(writerPid);
        await expect(execution.assertBinding(run.binding, reader)).rejects.toMatchObject({
          code: "not_granted"
        });
      });
    });
    expect((await fixture.tasks.get({
      ownerId: OWNER,
      taskId: fire.taskId
    }))?.status).toBe("running");
    expect((await fixture.repo.getFire(OWNER, fire.fireId))?.status).toBe("dispatched");
    let effects = 0;
    await expect((async () => {
      await execution.assertTool(run.binding, read);
      effects++;
    })()).rejects.toMatchObject({
      code: "not_granted"
    });
    expect(effects).toBe(0);
  });
  it("lease recovery by a new service fences the old binding and no second occurrence can run", async () => {
    const fixture = f!,
      fire = await fixture.claim(),
      run = await fixture.running(fire.fireId),
      oldExecution = fixture.execution();
    await oldExecution.assertBinding(run.binding);
    fixture.setClock(PG_LATER);
    await fixture.recover(fixture.execution());
    // Simulate an old process with its pre-expiry clock: persisted uncertain state must still deny it.
    fixture.setClock(PG_AT);
    await expect(oldExecution.assertBinding(run.binding)).rejects.toMatchObject({
      code: "not_granted"
    });
    let effects = 0;
    await expect((async () => {
      await oldExecution.assertTool(run.binding, read);
      effects++;
    })()).rejects.toMatchObject({
      code: "not_granted"
    });
    expect(effects).toBe(0);
    expect(await oldExecution.completeRun(run.input, {
      status: "completed"
    })).toEqual({
      status: "uncertain"
    });
    expect(await fixture.repo.claim({
      ownerId: OWNER,
      routineId: fixture.routine.routineId,
      scheduledFor: PG_NEXT,
      nextFireAt: null,
      now: PG_LATER
    })).toBeUndefined();
    expect(await fixture.repo.fires(OWNER, fixture.routine.routineId)).toHaveLength(1);
  });
  it.each(["archive", "share", "unbind"] as const)("committed %s from another transaction revokes old binding authorization and effects", async change => {
    const fixture = f!,
      fire = await fixture.claim(),
      run = await fixture.running(fire.fireId),
      execution = fixture.execution();
    await execution.assertTool(run.binding, read);
    await fixture.db.transaction().execute(async tx => {
      if (change === "archive") await tx.updateTable("chats").set({
        lifecycle: "archived"
      }).where("id", "=", PG_CHAT).execute();else if (change === "share") await tx.updateTable("chats").set({
        collaboration: {}
      }).where("id", "=", PG_CHAT).execute();else await tx.updateTable("bot_chat_bindings").set({
        removed_at: PG_AT
      }).where("owner_id", "=", OWNER).where("chat_id", "=", PG_CHAT).execute();
    });
    await expect(execution.assertBinding(run.binding)).rejects.toMatchObject({
      code: "not_granted"
    });
    await expect(execution.assertTool(run.binding, read)).rejects.toMatchObject({
      code: "not_granted"
    });
  });
  it.each(["cancelled", "replacement_run"] as const)("persisted task %s fences a still-live binding with a valid fire lease", async change => {
    const fixture = f!,
      fire = await fixture.claim(),
      run = await fixture.running(fire.fireId),
      execution = fixture.execution();
    await execution.assertBinding(run.binding);
    const task = (await fixture.tasks.get({
      ownerId: OWNER,
      taskId: fire.taskId
    }))!;
    if (change === "cancelled") await fixture.tasks.transition({
      ownerId: OWNER,
      taskId: fire.taskId,
      baseRevision: task.revision,
      to: "cancelled",
      now: PG_AT
    });else {
      const blocked = await fixture.tasks.transition({
        ownerId: OWNER,
        taskId: fire.taskId,
        baseRevision: task.revision,
        to: "blocked",
        blockedReason: "capacity_unavailable",
        now: PG_AT
      });
      await fixture.tasks.transition({
        ownerId: OWNER,
        taskId: fire.taskId,
        baseRevision: blocked.revision,
        to: "running",
        runId: "run_replacement_pg",
        now: PG_AT
      });
    }
    await expect(execution.assertBinding(run.binding)).rejects.toMatchObject({
      code: "not_granted"
    });
    await expect(execution.assertTool(run.binding, read)).rejects.toMatchObject({
      code: "not_granted"
    });
    expect((await fixture.repo.getFire(OWNER, fire.fireId))?.status).toBe("dispatched");
  });
  it("uses real durable proof with background off, then refuses a revoked source and a peer replaced during the DB wait", async () => {
    const fixture = f!, fire = await fixture.claim(), run = await fixture.running(fire.fireId), execution = fixture.execution();
    expect(fixture.source.background).toBe(false);
    const keys = generateKeyPairSync("ed25519"), der = keys.publicKey.export({type: "spki", format: "der"});
    let gate: Promise<void> | undefined, entered!: () => void;
    const peers = createChatGptPlanPeers({db: fixture.db, ownerId: OWNER, computerId: fixture.source.computerId,
      authorizeRoutine: async binding => { const proof = await execution.assertOccurrencePhase(binding); entered?.(); if (gate) await gate; return proof; }});
    async function connect() {
      const challenge = peers.challenge(OWNER), snapshot = {deviceId: createHash("sha256").update(der).digest("hex"),
        accountId: fixture.source.accountId, grantRevision: fixture.source.grantRevision, enabled: true, background: false,
        models: [{id: "fixture-model", displayName: "Fixture", input: ["text" as const], contextWindow: 8192, maxOutputTokens: 256}]};
      return peers.connect(OWNER, {version: 1, challenge: challenge.challenge, snapshot, publicKey: der.toString("base64url"),
        signature: sign(null, Buffer.from(chatGptPlanPeerProof({...challenge, snapshot})), keys.privateKey).toString("base64url")});
    }
    try {
      const session = await connect();
      expect(peers.capabilities(OWNER, session)).not.toHaveProperty("approvedRoutines");
      peers.capabilities(OWNER, session, false, false, true);
      const bound = {...run.binding, subscription: {...run.binding.subscription!, peerId: session.sessionId}};
      expect(await peers.revalidate(bound, new AbortController().signal)).toBe(true);
      const inference = peers.infer(bound, "{}", new AbortController().signal);
      const delivery = await peers.poll(OWNER, session);
      expect(delivery.requests[0]).toMatchObject({action: "infer", requestClass: "background", approvedRoutine: {
        ownerId: OWNER, taskId: fire.taskId, routineId: fixture.routine.routineId, fireId: fire.fireId,
        approvalId: fixture.routine.approvalId, runId: bound.runId }});
      peers.reply(OWNER, {...session, id: delivery.requests[0]!.id, ok: true, status: 200, headers: {"content-type": "text/event-stream"}, body: "fixture"});
      await expect(inference).resolves.toMatchObject({body: "fixture"});
      fixture.source.grantRevision++;
      expect(await peers.revalidate(bound, new AbortController().signal)).toBe(false);
      fixture.source.grantRevision--;
      let release!: () => void;
      gate = new Promise<void>(resolve => { release = resolve; });
      const waiting = new Promise<void>(resolve => { entered = resolve; });
      const checking = peers.infer(bound, "{}", new AbortController().signal);
      const refused = expect(checking).rejects.toThrow("unavailable");
      await waiting;
      await connect();
      release();
      await refused;
    } finally { peers.close(); }
  });
  it("deduplicates simultaneous edit reviews and refuses approval after a concurrent pause without changing the old definition", async () => {
    const fixture = f!, execution = fixture.execution();
    const input = {baseRevision: fixture.routine.revision, name: "Revised PG fixture", prompt: "Only revised fixture text", schedule: {kind: "interval", everyMs: 120000}};
    const [a, b] = await Promise.all([execution.requestEdit(OWNER, fixture.routine.routineId, input), execution.requestEdit(OWNER, fixture.routine.routineId, input)]);
    expect(a.interaction.interactionId).toBe(b.interaction.interactionId);
    expect((await fixture.repo.get(OWNER, fixture.routine.routineId))?.proposal).toEqual(fixture.routine.proposal);
    await execution.control(OWNER, BOT, fixture.routine.routineId, {status: "paused", baseRevision: fixture.routine.revision});
    await expect(fixture.interactions.resolve(OWNER, PG_CHAT, a.interaction.interactionId, {kind: "approval", decision: "approve", baseRevision: a.interaction.revision})).rejects.toThrow();
    const retained = await fixture.repo.get(OWNER, fixture.routine.routineId);
    expect(retained).toMatchObject({status: "paused", proposal: fixture.routine.proposal});
    expect(retained?.approvalId).toBe(fixture.routine.approvalId);
  });
  it.each(["background", "grant", "account", "computer", "definition"] as const)("external authority fixture change %s cannot retain the old persisted approval", async change => {
    const fixture = f!,
      fire = await fixture.claim(),
      run = await fixture.running(fire.fireId),
      execution = fixture.execution();
    await execution.assertBinding(run.binding);
    if (change === "background") { fixture.source.background = false; fixture.source.grantRevision++; }else if (change === "grant") fixture.source.grantRevision++;else if (change === "account") fixture.source.accountId = "different-fixture-account";else if (change === "computer") fixture.source.computerId = "different-fixture-computer";else fixture.source.definitionRevision++;
    await expect(execution.assertBinding(run.binding)).rejects.toMatchObject({
      code: "not_granted"
    });
    await expect(execution.assertTool(run.binding, read)).rejects.toMatchObject({
      code: "not_granted"
    });
    // This proves production guard behavior against a double, not real peer/file revocation.
    expect((await fixture.repo.get(OWNER, fixture.routine.routineId))?.authorization?.grantRevision).toBe(3);
  });
  it("all eight occupied PG sessions can revalidate through their caller transaction without another pool checkout", async () => {
    const fixture = f!,
      fire = await fixture.claim(),
      run = await fixture.running(fire.fireId),
      execution = fixture.execution();
    const ready = barrier<void>(),
      pids = new Set<number>();
    const results = await Promise.allSettled(Array.from({
      length: 8
    }, () => fixture.db.transaction().execute(async tx => {
      pids.add(await backendPid(tx));
      if (pids.size === 8) ready.resolve();
      await bounded(ready.promise);
      // Timeout throws inside the transaction, so even an accidental extra checkout releases the holder.
      return bounded(execution.assertBinding(run.binding, tx), 1800);
    })));
    expect(pids.size).toBe(8);
    expect(results.filter(result => result.status === "rejected")).toEqual([]);
    expect(results).toHaveLength(8);
  });
  it("live Chat revocation committed while the final Integration grant transaction waits prevents transport", async () => {
    const fixture = f!,
      fire = await fixture.claim(),
      run = await fixture.running(fire.fireId),
      execution = fixture.execution();
    await createBotGrantsRepository(fixture.db).grant({
      ownerId: OWNER,
      botId: BOT,
      service: "gmail",
      connectionId: "conn_pg_fixture",
      accountLabel: "Fixture",
      effects: ["read"],
      audience: "direct",
      grantedByActorId: OWNER,
      now: PG_AT
    });
    const entered = barrier<number>(),
      release = barrier<void>();
    let transports = 0;
    const unused = async () => {
      throw new Error("No external integration in PG fixture");
    };
    const tools = createBotIntegrationTools({
      transact: fixture.transact,
      now: () => new Date(PG_AT),
      client: {
        inventory: async () => [{
          connectionId: "conn_pg_fixture",
          service: "gmail",
          label: "Fixture"
        }],
        call: async () => {
          transports++;
          return {
            data: {
              fixture: true
            }
          };
        },
        describe: async () => [],
        connect: unused,
        sync: unused,
        callImportRead: unused,
        callAppAction: unused
      },
      agents: {
        get: async () => ({
          id: BOT,
          recipeRef: {
            recipeId: "pg-fixture",
            version: "1"
          }
        }) as never
      },
      recipes: createBotRecipeCatalog([{
        recipeId: "pg-fixture",
        version: "1",
        name: "Fixture",
        description: "Fixture",
        instructions: "Fixture",
        capabilities: ["integration.call"],
        integrations: [{
          service: "gmail",
          effects: ["read"],
          required: true
        }],
        output: "Fixture"
      }]),
      assertSource: async (binding, _signal, executor) => {
        if (executor) {
          entered.resolve(await backendPid(executor));
          await bounded(release.promise);
        }
        await execution.assertBinding(binding, executor);
      }
    });
    const pending = tools.call(run.binding, {
      service: "gmail",
      action: "list_threads",
      connectionId: "conn_pg_fixture",
      params: {}
    }).then(value => ({
      ok: true as const,
      value
    }), error => ({
      ok: false as const,
      error
    }));
    try {
      const sourcePid = await bounded(entered.promise);
      const writerPid = await fixture.db.transaction().execute(async tx => {
        const pid = await backendPid(tx);
        await tx.updateTable("chats").set({
          lifecycle: "archived"
        }).where("id", "=", PG_CHAT).execute();
        return pid;
      });
      expect(writerPid).not.toBe(sourcePid);
      expect(transports).toBe(0);
    } finally {
      release.resolve();
      await pending;
    }
    const result = await pending;
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "not_granted"
      }
    });
    expect(transports).toBe(0);
  });
  it("delivers occurrence phase only for the current approved native-PG binding", async () => {
    const fixture = f!, fire = await fixture.claim(), run = await fixture.running(fire.fireId);
    await expect(fixture.execution().assertOccurrencePhase(run.binding)).resolves.toMatchObject({ownerId: OWNER, routineId: fixture.routine.routineId, fireId: fire.fireId, taskId: fire.taskId, runId: run.binding.runId});
    await expect(fixture.execution().assertOccurrencePhase({ ...run.binding, ownerId: "foreign" })).rejects.toMatchObject({ code: "not_granted" });
  });
  it.each(["paused", "archived", "cancelled", "expired_lease", "invalidated_approval"] as const)("fences occurrence phase when %s changes on another PG connection during source validation", async change => {
    const fixture = f!, fire = await fixture.claim(), run = await fixture.running(fire.fireId);
    const entered = barrier<number>(), release = barrier<void>();
    let clock = PG_AT;
    const execution = createBotRoutineExecution({ db: fixture.db, transact: fixture.transact, now: () => new Date(clock),
      approvals: { ...fixture.approvals, authorize: (routine) => fixture.db.connection().execute(async source => {
        const allowed = await fixture.approvals.authorize(routine, source);
        entered.resolve(await backendPid(source)); await release.promise; return allowed;
      }) } });
    const pending = execution.assertOccurrencePhase(run.binding).then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
    try {
      const sourcePid = await bounded(entered.promise);
      await fixture.db.connection().execute(async writer => {
        expect(await backendPid(writer)).not.toBe(sourcePid);
        if (change === "paused" || change === "archived") await createBotRoutinesRepository(writer).control({ ownerId: OWNER,
          routineId: fixture.routine.routineId, baseRevision: (await fixture.repo.get(OWNER, fixture.routine.routineId))!.revision, status: change, now: PG_AT });
        else if (change === "cancelled") await createBotRoutinesRepository(writer).finish({ ownerId: OWNER, fireId: fire.fireId, status: "cancelled", now: PG_AT });
        else if (change === "expired_lease") clock = PG_LATER;
        else await writer.updateTable("bot_approvals").set({ status: "invalidated" }).where("approval_id", "=", fixture.routine.approvalId!).execute();
      });
    } finally { release.resolve(); await pending; }
    expect(await pending).toMatchObject({ ok: false, error: { code: "not_granted" } });
  });
});
