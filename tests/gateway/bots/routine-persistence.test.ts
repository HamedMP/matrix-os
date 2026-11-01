import { createBotRoutineScheduler } from "../../../packages/gateway/src/bots/routine-scheduler.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Kysely, sql } from "kysely";
import { createTestPGlite } from "../../helpers/pglite-test-helper.js";
import { bootstrapBotDatabase, type OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { createBotRoutinesRepository } from "../../../packages/gateway/src/bots/repositories/routines.js";
import { BotRoutineProposalSchema, type BotRoutineProposal } from "../../../packages/contracts/src/bots/routines.js";
const OWNER = "routine_owner",
  BOT = "bot_0123456789abcdef",
  CHAT = "chat_routines";
const NOW = "2026-10-18T12:00:00.000Z",
  NEXT = "2026-10-18T12:01:00.000Z";
const proposal: BotRoutineProposal = {
  name: "Daily check",
  prompt: "Summarize the saved test fixture",
  schedule: {
    kind: "interval",
    everyMs: 60_000
  },
  selection: {
    instanceId: "matrix_chatgpt_plan",
    model: "gpt-test"
  },
  authorizedEffects: ["read"]
};
let db: Kysely<OwnerBotDatabase>;
let repo: ReturnType<typeof createBotRoutinesRepository>;
beforeAll(async () => {
  const pg = await createTestPGlite();
  db = new Kysely<OwnerBotDatabase>({
    dialect: pg.dialect
  });
  // Only the two existing Chat prerequisites. All Bot migrations run unchanged.
  await sql`CREATE TABLE chats (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, owner_type TEXT NOT NULL, collaboration JSONB, lifecycle TEXT NOT NULL)`.execute(db);
  await sql`CREATE TABLE chat_runs (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, driver_kind TEXT NOT NULL)`.execute(db);
  await bootstrapBotDatabase(db);
  await sql`INSERT INTO chats VALUES (${CHAT}, ${OWNER}, 'personal', NULL, 'active')`.execute(db);
  await db.insertInto("bot_chat_bindings").values({
    owner_id: OWNER,
    bot_id: BOT,
    chat_id: CHAT,
    kind: "direct",
    created_at: NOW,
    removed_at: null
  }).execute();
  repo = createBotRoutinesRepository(db);
});
afterAll(async () => {
  await db?.destroy();
});
async function create() {
  return repo.create({
    ownerId: OWNER,
    botId: BOT,
    chatId: CHAT,
    proposal,
    nextFireAt: NEXT,
    now: NOW
  });
}
describe("owner routines", () => {
  it("validates schedules and refuses authority/route injection", () => {
    expect(BotRoutineProposalSchema.safeParse(proposal).success).toBe(true);
    for (const bad of [{
      ...proposal,
      ownerId: "other"
    }, {
      ...proposal,
      schedule: {
        kind: "interval",
        everyMs: 1
      }
    }, {
      ...proposal,
      authorizedEffects: ["shell"]
    }, {
      ...proposal,
      selection: {
        instanceId: "owner_key",
        model: "x"
      }
    }, {
      ...proposal,
      schedule: {
        kind: "cron",
        expr: "* * * * *",
        tz: "Not/AZone"
      }
    }]) expect(BotRoutineProposalSchema.safeParse(bad).success).toBe(false);
  });
  it("persists owner-scoped data and enforces revisions", async () => {
    const r = await create();
    expect((await repo.get(OWNER, r.routineId))?.status).toBe("active");
    expect(await repo.get("other", r.routineId)).toBeUndefined();
    const paused = await repo.control({
      ownerId: OWNER,
      routineId: r.routineId,
      baseRevision: r.revision,
      status: "paused",
      now: NOW
    });
    expect(paused.status).toBe("paused");
    await expect(repo.control({
      ownerId: OWNER,
      routineId: r.routineId,
      baseRevision: r.revision,
      status: "active",
      now: NOW
    })).rejects.toMatchObject({
      code: "revision_conflict"
    });
  });
  it("cannot create for a foreign or non-direct Bot Chat", async () => {
    await expect(repo.create({
      ownerId: "other",
      botId: BOT,
      chatId: CHAT,
      proposal,
      nextFireAt: NEXT,
      now: NOW
    })).rejects.toMatchObject({
      code: "not_found"
    });
    await expect(repo.create({
      ownerId: OWNER,
      botId: "bot_abcdef0123456789",
      chatId: CHAT,
      proposal,
      nextFireAt: NEXT,
      now: NOW
    })).rejects.toMatchObject({
      code: "not_found"
    });
  });
  it("claims one occurrence and one existing canonical task atomically, persisting through repository restart", async () => {
    const r = await create();
    const fire = await repo.claim({
      ownerId: OWNER,
      routineId: r.routineId,
      scheduledFor: NEXT,
      nextFireAt: "2026-10-18T12:02:00.000Z",
      now: NEXT
    });
    expect(fire?.taskId).toMatch(/^task_/);
    expect(await repo.claim({
      ownerId: OWNER,
      routineId: r.routineId,
      scheduledFor: NEXT,
      nextFireAt: null,
      now: NEXT
    })).toBeUndefined();
    const restarted = createBotRoutinesRepository(db);
    const stored = await restarted.fires(OWNER, r.routineId);
    expect(stored).toHaveLength(1);
    expect(stored[0].taskId).toBe(fire!.taskId);
    const task = await db.selectFrom("bot_tasks").selectAll().where("task_id", "=", fire!.taskId).executeTakeFirstOrThrow();
    expect(task.status).toBe("queued");
    expect(task.owner_id).toBe(OWNER);
    expect(task.bot_id).toBe(BOT);
    expect(await restarted.fires("other", r.routineId)).toEqual([]);
  });
  it("pause/archive prevent claims and archived routines cannot be resumed", async () => {
    const r = await create();
    const paused = await repo.control({
      ownerId: OWNER,
      routineId: r.routineId,
      baseRevision: r.revision,
      status: "paused",
      now: NOW
    });
    expect(await repo.claim({
      ownerId: OWNER,
      routineId: r.routineId,
      scheduledFor: NEXT,
      nextFireAt: null,
      now: NEXT
    })).toBeUndefined();
    const archived = await repo.control({
      ownerId: OWNER,
      routineId: r.routineId,
      baseRevision: paused.revision,
      status: "archived",
      now: NOW
    });
    await expect(repo.control({
      ownerId: OWNER,
      routineId: r.routineId,
      baseRevision: archived.revision,
      status: "active",
      now: NOW
    })).rejects.toMatchObject({
      code: "invalid_transition"
    });
  });
  it("terminal fire settlement also closes its canonical task", async () => {
    const r = await create(),
      fire = await repo.claim({
        ownerId: OWNER,
        routineId: r.routineId,
        scheduledFor: NEXT,
        nextFireAt: null,
        now: NEXT
      });
    await repo.finish({
      ownerId: OWNER,
      fireId: fire!.fireId,
      status: "failed",
      failureCode: "background_not_authorized",
      now: NEXT
    });
    const task = await db.selectFrom("bot_tasks").select("status").where("task_id", "=", fire!.taskId).executeTakeFirstOrThrow();
    expect(task.status).toBe("failed");
  });
  it("a pause after authorization began fences the later dispatch", async () => {
    const r = await create(),
      fire = await repo.claim({
        ownerId: OWNER,
        routineId: r.routineId,
        scheduledFor: NEXT,
        nextFireAt: null,
        now: NEXT
      });
    const latest = await repo.get(OWNER, r.routineId);
    await repo.control({
      ownerId: OWNER,
      routineId: r.routineId,
      baseRevision: latest!.revision,
      status: "paused",
      now: NEXT
    });
    expect(await repo.dispatch({
      ownerId: OWNER,
      fireId: fire!.fireId,
      now: NEXT
    })).toBeUndefined();
  });
  it("another scheduler start does not invalidate a live, bounded dispatch lease", async () => {
    const r = await create(),
      fire = await repo.claim({
        ownerId: OWNER,
        routineId: r.routineId,
        scheduledFor: NEXT,
        nextFireAt: null,
        now: NEXT
      });
    await repo.dispatch({
      ownerId: OWNER,
      fireId: fire!.fireId,
      now: NEXT
    });
    await repo.recover({
      before: "2026-10-18T12:02:00.000Z",
      now: "2026-10-18T12:02:00.000Z"
    });
    expect((await repo.fires(OWNER, r.routineId))[0].status).toBe("dispatched");
  });
  it("rechecks the live personal Chat at claim", async () => {
    const r = await create();
    await sql`UPDATE chats SET lifecycle='archived' WHERE id=${CHAT}`.execute(db);
    try {
      expect(await repo.claim({
        ownerId: OWNER,
        routineId: r.routineId,
        scheduledFor: NEXT,
        nextFireAt: null,
        now: NEXT
      })).toBeUndefined();
    } finally {
      await sql`UPDATE chats SET lifecycle='active' WHERE id=${CHAT}`.execute(db);
    }
  });
  it("rechecks the live personal Chat at dispatch", async () => {
    const r = await create(),
      fire = await repo.claim({
        ownerId: OWNER,
        routineId: r.routineId,
        scheduledFor: NEXT,
        nextFireAt: null,
        now: NEXT
      });
    await sql`UPDATE chats SET collaboration='{}'::jsonb WHERE id=${CHAT}`.execute(db);
    try {
      expect(await repo.dispatch({
        ownerId: OWNER,
        fireId: fire!.fireId,
        now: NEXT
      })).toBeUndefined();
    } finally {
      await sql`UPDATE chats SET collaboration=NULL WHERE id=${CHAT}`.execute(db);
    }
  });
  it("does not dispatch early during safe retry backoff", async () => {
    const r = await create(),
      fire = await repo.claim({
        ownerId: OWNER,
        routineId: r.routineId,
        scheduledFor: NEXT,
        nextFireAt: null,
        now: NEXT
      });
    await repo.dispatch({
      ownerId: OWNER,
      fireId: fire!.fireId,
      now: NEXT
    });
    await repo.defer({
      ownerId: OWNER,
      fireId: fire!.fireId,
      retryAfter: "2026-10-18T12:02:00.000Z",
      now: NEXT
    });
    expect(await repo.dispatch({
      ownerId: OWNER,
      fireId: fire!.fireId,
      now: NEXT
    })).toBeUndefined();
    expect((await repo.fires(OWNER, r.routineId))[0].attempts).toBe(1);
  });
  it("a dispatched outcome lost across restart becomes uncertain, never queued/replayed", async () => {
    const r = await create(),
      fire = await repo.claim({
        ownerId: OWNER,
        routineId: r.routineId,
        scheduledFor: NEXT,
        nextFireAt: null,
        now: NEXT
      });
    await repo.dispatch({
      ownerId: OWNER,
      fireId: fire!.fireId,
      now: NEXT
    });
    const recovered = await repo.recover({
      before: "2026-10-18T12:15:00.000Z",
      now: "2026-10-18T12:15:00.000Z"
    });
    expect(recovered).toBe(2);
    expect((await repo.fires(OWNER, r.routineId))[0]).toMatchObject({
      status: "uncertain",
      failureCode: "restart_outcome_unknown"
    });
    expect(await repo.dispatch({
      ownerId: OWNER,
      fireId: fire!.fireId,
      now: NEXT
    })).toBeUndefined();
  });
});
it("an old pending authorization snapshot cannot finish another scheduler's dispatched task", async () => {
  const r = await create(),
    f = (await repo.claim({
      ownerId: OWNER,
      routineId: r.routineId,
      scheduledFor: NEXT,
      nextFireAt: null,
      now: NEXT
    }))!;
  const selected = {
    ...repo,
    due: async () => [],
    pending: async () => {
      const current = await repo.getFire(OWNER, f.fireId);
      return current?.status === "claimed" ? [current] : [];
    }
  };
  let rejectAuthorization!: () => void, enteredA!: () => void, finishRun!: () => void, enteredB!: () => void;
  const authorizing = new Promise<void>(resolve => {
      enteredA = resolve;
    }),
    running = new Promise<void>(resolve => {
      enteredB = resolve;
    });
  const a = createBotRoutineScheduler({
    repository: selected,
    now: () => new Date(NEXT),
    authorize: async () => {
      enteredA();
      return new Promise<boolean>(resolve => {
        rejectAuthorization = () => resolve(false);
      });
    },
    run: async () => ({
      status: "failed"
    })
  });
  const b = createBotRoutineScheduler({
    repository: selected,
    now: () => new Date(NEXT),
    authorize: async () => true,
    run: async () => {
      const t = (await createBotTasksRepository(db).get({
        ownerId: OWNER,
        taskId: f.taskId
      }))!;
      await createBotTasksRepository(db).transition({
        ownerId: OWNER,
        taskId: f.taskId,
        baseRevision: t.revision,
        to: "running",
        runId: "run_owned_by_scheduler_b",
        now: NEXT
      });
      enteredB();
      return new Promise(resolve => {
        finishRun = () => resolve({
          status: "completed"
        });
      });
    }
  });
  const first = a.tick();
  await authorizing;
  const second = b.tick();
  await running;
  try {
    rejectAuthorization();
    await first;
    expect((await repo.getFire(OWNER, f.fireId))?.status).toBe("dispatched");
    expect((await createBotTasksRepository(db).get({
      ownerId: OWNER,
      taskId: f.taskId
    }))?.status).toBe("running");
  } finally {
    finishRun();
    await second;
    await a.stop();
    await b.stop();
  }
  expect((await repo.getFire(OWNER, f.fireId))?.status).toBe("completed");
});
it("32 invalid Chat rows cannot starve the next live due or pending fire", async () => {
  const candidates = [];
  for (let i = 0; i < 33; i++) {
    const owner = "queue_fixture_" + i,
      chat = "chat_queue_fixture_" + i;
    await sql`INSERT INTO chats VALUES (${chat},${owner},'personal',NULL,'active')`.execute(db);
    await db.insertInto("bot_chat_bindings").values({
      owner_id: owner,
      bot_id: BOT,
      chat_id: chat,
      kind: "direct",
      created_at: NOW,
      removed_at: null
    }).execute();
    const dueAt = i < 32 ? "2026-10-18T12:00:01.000Z" : "2026-10-18T12:00:02.000Z";
    const r = await repo.create({
      ownerId: owner,
      botId: BOT,
      chatId: chat,
      proposal,
      nextFireAt: dueAt,
      now: NOW
    });
    candidates.push(r);
    if (i < 32) await sql`UPDATE chats SET lifecycle='archived' WHERE id=${chat}`.execute(db);
  }
  const live = candidates[32],
    due = (await repo.due(NEXT)).some(r => r.routineId === live.routineId);
  for (const r of candidates) {
    await sql`UPDATE chats SET lifecycle='active' WHERE id=${r.chatId}`.execute(db);
    await repo.claim({
      ownerId: r.ownerId,
      routineId: r.routineId,
      scheduledFor: r.nextFireAt!,
      nextFireAt: null,
      now: r.nextFireAt!
    });
    if (r.routineId !== live.routineId) await sql`UPDATE chats SET lifecycle='archived' WHERE id=${r.chatId}`.execute(db);
  }
  expect({
    due,
    pending: (await repo.pending(NEXT)).some(f => f.routineId === live.routineId)
  }).toEqual({
    due: true,
    pending: true
  });
});
it("a lost lease retains the uncertain occurrence gate while the old worker may still be alive", async () => {
  const r = await create(),
    f = (await repo.claim({
      ownerId: OWNER,
      routineId: r.routineId,
      scheduledFor: NEXT,
      nextFireAt: "2026-10-18T12:02:00.000Z",
      now: NEXT
    }))!;
  await repo.dispatch({
    ownerId: OWNER,
    fireId: f.fireId,
    now: NEXT
  });
  await repo.recover({
    before: "2026-10-18T12:15:00.000Z",
    now: "2026-10-18T12:15:00.000Z"
  });
  expect((await repo.getFire(OWNER, f.fireId))?.status).toBe("uncertain");
  expect(await repo.claim({
    ownerId: OWNER,
    routineId: r.routineId,
    scheduledFor: "2026-10-18T12:02:00.000Z",
    nextFireAt: "2026-10-18T12:16:00.000Z",
    now: "2026-10-18T12:15:00.000Z"
  })).toBeUndefined();
  expect(await repo.fires(OWNER, r.routineId)).toHaveLength(1);
});
it("pauses a failed recurring routine instead of filling the Chat with repeated failed runs", async () => {
  const r = await create(),
    f = (await repo.claim({
      ownerId: OWNER,
      routineId: r.routineId,
      scheduledFor: NEXT,
      nextFireAt: "2026-10-18T12:02:00.000Z",
      now: NEXT
    }))!;
  await repo.finish({
    ownerId: OWNER,
    fireId: f.fireId,
    status: "failed",
    failureCode: "background_not_authorized",
    expectedStatus: "claimed",
    now: NEXT
  });
  expect((await repo.get(OWNER, r.routineId))?.status).toBe("paused");
  expect(await repo.claim({
    ownerId: OWNER,
    routineId: r.routineId,
    scheduledFor: "2026-10-18T12:02:00.000Z",
    nextFireAt: null,
    now: "2026-10-18T12:02:00.000Z"
  })).toBeUndefined();
});
