/** Real-PG persisted fencing tests, NOT a real device/worker/model qualification.
 * External subscription/file authority is a controlled double; DB policy/approval/fire/task is real.
 * This suite has not been run in the database-free preparation phase.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBotRoutinesRepository } from "../../../packages/gateway/src/bots/repositories/routines.js";
import { createBotIntegrationTools } from "../../../packages/gateway/src/bots/integration-tools.js";
import { createBotGrantsRepository } from "../../../packages/gateway/src/bots/repositories/grants.js";
import { createBotRecipeCatalog } from "../../../packages/gateway/src/bots/recipe-catalog.js";
import type { BotToolRequest } from "@matrix-os/contracts";
import { BOT, OWNER, PG_AT, PG_CHAT, PG_LATER, PG_NEXT, backendPid, barrier, bounded, createPgRoutineFixture, pgEnabled, type PgRoutineFixture } from "./routine-postgres-support.js";
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
  it.each(["background", "grant", "account", "computer", "definition"] as const)("external authority fixture change %s cannot retain the old persisted approval", async change => {
    const fixture = f!,
      fire = await fixture.claim(),
      run = await fixture.running(fire.fireId),
      execution = fixture.execution();
    await execution.assertBinding(run.binding);
    if (change === "background") fixture.source.background = false;else if (change === "grant") fixture.source.grantRevision++;else if (change === "account") fixture.source.accountId = "different-fixture-account";else if (change === "computer") fixture.source.computerId = "different-fixture-computer";else fixture.source.definitionRevision++;
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
});
