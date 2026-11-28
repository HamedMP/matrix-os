import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely, sql } from "kysely";
import { RuntimeLifecycleStatusSchema } from "@matrix-os/contracts/runtime-lifecycle";
import { bootstrapChatDatabase, type ChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { bootstrapBotDatabase, type OwnerBotDatabase } from "../../packages/gateway/src/bots/database.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { createBotRoutinesRepository } from "../../packages/gateway/src/bots/repositories/routines.js";
import { createCronStore } from "../../packages/gateway/src/cron/store.js";
import { createCronService, type CronService } from "../../packages/gateway/src/cron/service.js";
import { createTerminalLiveOwnership } from "../../packages/gateway/src/terminal-live-ownership.js";
import { createChatRunActivity, createLifecycleReadGuard, gatewayLifecycleSources, readLifecycleStatus } from "../../packages/gateway/src/lifecycle/status.js";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";
import { insertChat } from "./bots/bot-state-support.js";

const NOW = new Date("2026-11-21T12:00:00.000Z");
const HOUR = 60 * 60_000;
const OWNER = "lifecycle_owner";
const BOT = "bot_0123456789abcdef";
const CHAT = "chat_lifecycle";

let db: Kysely<ChatDatabase & OwnerBotDatabase>;
let runSeq = 0;

beforeAll(async () => {
  const pg = await createTestPGlite();
  db = new Kysely<ChatDatabase & OwnerBotDatabase>({ dialect: pg.dialect });
  await bootstrapChatDatabase(db);
  await bootstrapBotDatabase(db as never);
  await bootstrapCollaborationDatabase(db as never);
});

afterAll(async () => {
  await db?.destroy();
});

beforeEach(async () => {
  await sql`SET session_replication_role = replica`.execute(db);
  await db.deleteFrom("chat_runs").execute();
  await sql`SET session_replication_role = DEFAULT`.execute(db);
});

/** Run rows only; FK checks are disabled so the test does not need full turn/message fixtures. */
async function insertRun(status: string, updatedAt: Date): Promise<void> {
  runSeq += 1;
  await sql`SET session_replication_role = replica`.execute(db);
  try {
    await sql`INSERT INTO chat_runs (id, chat_id, turn_id, client_request_id, attempt, driver_kind, instance_id,
      selection, interaction_mode, permission_mode, status, history_boundary_seq, capability_snapshot, created_at, updated_at)
      VALUES (${`run_${runSeq}`}, ${`chat_${runSeq}`}, ${`turn_${runSeq}`}, ${`req_${runSeq}`}, 1, 'claude', 'claude_default',
      '{}'::jsonb, 'default', 'supervised', ${status}, 0, '{}'::jsonb, ${updatedAt.toISOString()}, ${updatedAt.toISOString()})`.execute(db);
  } finally {
    await sql`SET session_replication_role = DEFAULT`.execute(db);
  }
}

describe("lifecycle status", () => {
  it("busy with chat_run while a run is running", async () => {
    await insertRun("running", new Date(NOW.getTime() - 3 * 24 * HOUR));
    const status = await readLifecycleStatus({ chatRuns: createChatRunActivity(db), now: () => NOW });
    expect(RuntimeLifecycleStatusSchema.parse(status)).toEqual({ busy: true, busyReasons: ["chat_run"], nextScheduledAt: null, scheduleComplete: true });
  });

  it("busy with an accepted run", async () => {
    await insertRun("accepted", NOW);
    const status = await readLifecycleStatus({ chatRuns: createChatRunActivity(db), now: () => NOW });
    expect(status.busyReasons).toEqual(["chat_run"]);
  });

  it("not busy with only waiting runs older than 24 h", async () => {
    await insertRun("waiting_for_input", new Date(NOW.getTime() - 25 * HOUR));
    await insertRun("waiting_for_approval", new Date(NOW.getTime() - 25 * HOUR));
    await insertRun("completed", NOW);
    await insertRun("failed", NOW);
    const status = await readLifecycleStatus({ chatRuns: createChatRunActivity(db), now: () => NOW });
    expect(status).toEqual({ busy: false, busyReasons: [], nextScheduledAt: null, scheduleComplete: true });
  });

  it("busy with a waiting run updated within 24 h", async () => {
    await insertRun("waiting_for_approval", new Date(NOW.getTime() - 23 * HOUR));
    const status = await readLifecycleStatus({ chatRuns: createChatRunActivity(db), now: () => NOW });
    expect(status.busyReasons).toEqual(["chat_run"]);
  });

  it("reports terminal, background agent and routine activity", async () => {
    const ownership = createTerminalLiveOwnership({ now: () => NOW.getTime() });
    ownership.attach({ key: "owner:ws:tab", viewerId: "viewer_1", exclusive: false, onRevoked: () => undefined });
    const status = await readLifecycleStatus({
      terminals: ownership,
      backgroundAgents: { anyRunning: async () => true },
      routines: { hasActiveFire: async () => true, nextFireAt: async () => null },
      now: () => NOW,
    });
    expect(status).toEqual({
      busy: true,
      busyReasons: ["terminal_attached", "background_agent", "routine"],
      nextScheduledAt: null,
      scheduleComplete: true,
    });
  });

  it("fails safe toward awake when a busy source errors or times out", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const status = await readLifecycleStatus({
        chatRuns: { hasActiveRun: async () => { throw new Error("connection terminated at 10.0.0.4"); } },
        backgroundAgents: { anyRunning: () => new Promise<boolean>(() => undefined) },
        timeoutMs: 20,
        now: () => NOW,
      });
      expect(status).toEqual({ busy: true, busyReasons: ["unknown"], nextScheduledAt: null, scheduleComplete: true });
      expect(RuntimeLifecycleStatusSchema.parse(status).busyReasons).toEqual(["unknown"]);
    } finally {
      warn.mockRestore();
    }
  });

  it("busy with chat_run while the dispatcher is answering or has queued messages", async () => {
    for (const dispatcher of [{ activeCount: 1, queueLength: 0 }, { activeCount: 0, queueLength: 2 }]) {
      const status = await readLifecycleStatus({ dispatcher, now: () => NOW });
      expect(status).toEqual({ busy: true, busyReasons: ["chat_run"], nextScheduledAt: null, scheduleComplete: true });
    }
    const idle = await readLifecycleStatus({ dispatcher: { activeCount: 0, queueLength: 0 }, now: () => NOW });
    expect(idle.busy).toBe(false);
  });

  it("reports chat_run once when both chat runs and the dispatcher are busy", async () => {
    const status = await readLifecycleStatus({
      chatRuns: { hasActiveRun: async () => true }, dispatcher: { activeCount: 1, queueLength: 0 }, now: () => NOW,
    });
    expect(RuntimeLifecycleStatusSchema.parse(status).busyReasons).toEqual(["chat_run"]);
  });

  it("does not start a second read of a source whose earlier read is still pending", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      let release: (value: boolean) => void = () => undefined;
      const hasActiveRun = vi.fn(async () => false)
        .mockImplementationOnce(() => new Promise<boolean>((resolve) => { release = resolve; }));
      const readGuard = createLifecycleReadGuard();
      const sources = { chatRuns: { hasActiveRun }, readGuard, timeoutMs: 20, now: () => NOW };
      expect((await readLifecycleStatus(sources)).busyReasons).toEqual(["unknown"]);
      expect((await readLifecycleStatus(sources)).busyReasons).toEqual(["unknown"]);
      expect(hasActiveRun).toHaveBeenCalledTimes(1);
      release(false);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect((await readLifecycleStatus(sources)).busy).toBe(false);
      expect(hasActiveRun).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("marks the schedule complete when every schedule source answers", async () => {
    const status = await readLifecycleStatus({
      cron: { nextRunAt: () => new Date(NOW.getTime() + 2 * HOUR) },
      routines: { hasActiveFire: async () => false, nextFireAt: async () => new Date(NOW.getTime() + HOUR) },
      now: () => NOW,
    });
    expect(status).toEqual({ busy: false, busyReasons: [], nextScheduledAt: new Date(NOW.getTime() + HOUR).toISOString(), scheduleComplete: true });
  });

  it("marks the schedule incomplete with the answering source's time when one schedule source throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const status = await readLifecycleStatus({
        cron: { nextRunAt: () => new Date(NOW.getTime() + HOUR) },
        routines: { hasActiveFire: async () => false, nextFireAt: async () => { throw new Error("db down"); } },
        now: () => NOW,
      });
      expect(RuntimeLifecycleStatusSchema.parse(status)).toEqual({
        busy: false, busyReasons: [], nextScheduledAt: new Date(NOW.getTime() + HOUR).toISOString(), scheduleComplete: false,
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("marks the schedule incomplete with a null time when every schedule source fails or times out", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const status = await readLifecycleStatus({
        cron: { nextRunAt: () => { throw new Error("cron broken"); } },
        routines: { hasActiveFire: async () => false, nextFireAt: () => new Promise<Date | null>(() => undefined) },
        timeoutMs: 20,
        now: () => NOW,
      });
      expect(status).toEqual({ busy: false, busyReasons: [], nextScheduledAt: null, scheduleComplete: false });
    } finally {
      warn.mockRestore();
    }
  });

  it("marks the schedule incomplete while an overdue cron job masks a future one", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const homePath = mkdtempSync(join(tmpdir(), "lifecycle-overdue-cron-"));
    const store = createCronStore(join(homePath, "cron.json"));
    const onTrigger = vi.fn();
    const service = createCronService({ store, onTrigger });
    const overdueAt = new Date(NOW.getTime() - 60_000).toISOString();
    const futureAt = new Date(NOW.getTime() + HOUR).toISOString();
    try {
      store.save([overdueAt, futureAt].map((at, index) => ({
        id: `reminder-${index}`, name: "Reminder", message: "Check in",
        createdAt: overdueAt, schedule: { type: "once", at },
      })));
      service.start();
      const sources = { cron: service, now: () => NOW };
      expect(onTrigger).not.toHaveBeenCalled();
      expect(service.nextRunAt()?.toISOString()).toBe(overdueAt);
      expect(RuntimeLifecycleStatusSchema.parse(await readLifecycleStatus(sources))).toEqual({
        busy: false, busyReasons: [], nextScheduledAt: null, scheduleComplete: false,
      });

      service.removeJob("reminder-0");
      expect(RuntimeLifecycleStatusSchema.parse(await readLifecycleStatus(sources))).toEqual({
        busy: false, busyReasons: [], nextScheduledAt: futureAt, scheduleComplete: true,
      });
    } finally {
      service.stop();
      vi.useRealTimers();
      rmSync(homePath, { recursive: true, force: true });
    }
  });

  it("ignores routine times in the past without marking the schedule incomplete", async () => {
    const futureAt = new Date(NOW.getTime() + 2 * HOUR);
    const status = await readLifecycleStatus({
      cron: { nextRunAt: () => futureAt },
      routines: { hasActiveFire: async () => false, nextFireAt: async () => new Date(NOW.getTime() - 60_000) },
      now: () => NOW,
    });
    expect(status.nextScheduledAt).toBe(futureAt.toISOString());
    expect(status.scheduleComplete).toBe(true);
  });
});

describe("lifecycle nextScheduledAt with real cron and routines", () => {
  let homePath: string;
  let cronService: CronService;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    homePath = mkdtempSync(join(tmpdir(), "lifecycle-cron-"));
    mkdirSync(join(homePath, "system"), { recursive: true });
    cronService = createCronService({ store: createCronStore(join(homePath, "system", "cron.json")), onTrigger: () => undefined });
    cronService.start();
  });

  afterEach(() => {
    cronService.stop();
    vi.useRealTimers();
    rmSync(homePath, { recursive: true, force: true });
  });

  it("nextScheduledAt is the earliest of cron and routine", async () => {
    await insertChat(db as never, CHAT, OWNER);
    await db.insertInto("bot_chat_bindings").values({
      owner_id: OWNER, bot_id: BOT, chat_id: CHAT, kind: "direct", created_at: NOW.toISOString(), removed_at: null,
    }).execute();
    const routines = createBotRoutinesRepository(db as never);
    const routineAt = new Date(NOW.getTime() + 90 * 60_000);
    await routines.create({
      ownerId: OWNER, botId: BOT, chatId: CHAT, nextFireAt: routineAt.toISOString(), now: NOW.toISOString(),
      proposal: {
        name: "Daily check", prompt: "Summarize the saved test fixture",
        schedule: { kind: "interval", everyMs: 60_000 },
        selection: { instanceId: "matrix_chatgpt_plan", model: "gpt-test" },
        authorizedEffects: ["read"],
      },
    });
    const created = new Date(NOW).toISOString();
    cronService.addJob({ id: "cron_daily", name: "daily", message: "m", createdAt: created, schedule: { type: "cron", cron: "0 18 * * *" } });
    cronService.addJob({ id: "cron_once", name: "once", message: "m", createdAt: created, schedule: { type: "once", at: new Date(NOW.getTime() + 2 * HOUR).toISOString() } });

    const sources = { cron: cronService, routines: { hasActiveFire: (at: Date) => routines.hasActiveFire(at.toISOString()), nextFireAt: (at: Date) => routines.nextFireAt(at.toISOString()) }, now: () => NOW };
    expect((await readLifecycleStatus(sources)).nextScheduledAt).toBe(routineAt.toISOString());

    cronService.addJob({ id: "cron_soon", name: "soon", message: "m", createdAt: created, schedule: { type: "interval", intervalMs: 30 * 60_000 } });
    const status = await readLifecycleStatus(sources);
    expect(status).toEqual({ busy: false, busyReasons: [], nextScheduledAt: new Date(NOW.getTime() + 30 * 60_000).toISOString(), scheduleComplete: true });
  });
  it("counts claimed and leased routine fires as executing, and deferred retries as scheduled", async () => {
    const chat = "chat_lifecycle_fire", bot = "bot_fedcba9876543210";
    await insertChat(db as never, chat, OWNER);
    await db.insertInto("bot_chat_bindings").values({
      owner_id: OWNER, bot_id: bot, chat_id: chat, kind: "direct", created_at: NOW.toISOString(), removed_at: null,
    }).execute();
    const routines = createBotRoutinesRepository(db as never);
    const dueAt = new Date(NOW.getTime() + 60_000).toISOString();
    const created = await routines.create({
      ownerId: OWNER, botId: bot, chatId: chat, nextFireAt: dueAt, now: NOW.toISOString(),
      proposal: {
        name: "Fire check", prompt: "Summarize the saved test fixture",
        schedule: { kind: "interval", everyMs: 60 * 60_000 },
        selection: { instanceId: "matrix_chatgpt_plan", model: "gpt-test" },
        authorizedEffects: ["read"],
      },
    });
    const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
    expect(await routines.hasActiveFire(at(30_000))).toBe(false);
    // Due but not yet claimed by the 15 s scheduler pass: it must keep the computer awake.
    expect(await routines.hasActiveFire(at(2 * 60_000))).toBe(true);
    const fire = await routines.claim({ ownerId: OWNER, routineId: created.routineId, scheduledFor: dueAt, nextFireAt: at(4 * HOUR), now: at(2 * 60_000) });
    expect(fire).toBeTruthy();
    expect(await routines.hasActiveFire(at(2 * 60_000))).toBe(true);
    const fireId = (fire as { fireId: string }).fireId;
    expect(await routines.dispatch({ ownerId: OWNER, fireId, now: at(3 * 60_000) })).toBeTruthy();
    expect(await routines.hasActiveFire(at(4 * 60_000))).toBe(true);
    // The 12 minute dispatch lease expired: recovery owns it, it must not pin the VM awake.
    expect(await routines.hasActiveFire(at(16 * 60_000))).toBe(false);
    const retryAfter = at(30 * 60_000);
    expect(await routines.defer({ ownerId: OWNER, fireId, retryAfter, now: at(5 * 60_000) })).toBeTruthy();
    expect(await routines.hasActiveFire(at(6 * 60_000))).toBe(false);
    expect(await routines.hasActiveFire(at(31 * 60_000))).toBe(true);
    expect((await routines.nextFireAt(at(6 * 60_000)))?.toISOString()).toBe(retryAfter);
  });
});

describe("gateway lifecycle source composition", () => {
  const cronAt = new Date(NOW.getTime() + HOUR);
  const base = {
    terminals: { attachedViewerCount: () => 0 },
    backgroundAgents: { anyRunning: async () => false },
    cron: { nextRunAt: () => cronAt },
    dispatcher: { activeCount: 0, queueLength: 0 },
  };
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warn = vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(() => { warn.mockRestore(); });

  it("reports unknown and an incomplete schedule before bot services have started", async () => {
    const sources = gatewayLifecycleSources({ ...base, ownerDatabaseConfigured: true, chatDb: db, bots: null });
    expect(await readLifecycleStatus({ ...sources, now: () => NOW })).toEqual({
      busy: true, busyReasons: ["unknown"], nextScheduledAt: cronAt.toISOString(), scheduleComplete: false,
    });
  });

  it("reports unknown and an incomplete schedule when the configured owner database did not start", async () => {
    const sources = gatewayLifecycleSources({ ...base, ownerDatabaseConfigured: true, chatDb: null, bots: null });
    expect(await readLifecycleStatus({ ...sources, now: () => NOW })).toEqual({
      busy: true, busyReasons: ["unknown"], nextScheduledAt: cronAt.toISOString(), scheduleComplete: false,
    });
  });

  it("treats chat runs and routines as not applicable without an owner database", async () => {
    const sources = gatewayLifecycleSources({ ...base, ownerDatabaseConfigured: false, chatDb: null, bots: null });
    expect(await readLifecycleStatus({ ...sources, now: () => NOW })).toEqual({
      busy: false, busyReasons: [], nextScheduledAt: cronAt.toISOString(), scheduleComplete: true,
    });
  });

  it("treats routines as not applicable once bot services started without them", async () => {
    const sources = gatewayLifecycleSources({ ...base, ownerDatabaseConfigured: true, chatDb: db, bots: { routines: false } });
    expect(sources.routines).toBeUndefined();
    expect(await readLifecycleStatus({ ...sources, now: () => NOW })).toEqual({
      busy: false, busyReasons: [], nextScheduledAt: cronAt.toISOString(), scheduleComplete: true,
    });
  });

  it("reads chat runs and routines once the owner database and bot routines are ready", async () => {
    const sources = gatewayLifecycleSources({ ...base, ownerDatabaseConfigured: true, chatDb: db, bots: { routines: true } });
    const status = await readLifecycleStatus({ ...sources, now: () => NOW });
    expect(status).toMatchObject({ busy: false, busyReasons: [], scheduleComplete: true });
    expect(warn).not.toHaveBeenCalled();
  });

  it("never includes the heartbeat among the composed sources", () => {
    for (const bots of [null, { routines: true }]) {
      const sources = gatewayLifecycleSources({ ...base, ownerDatabaseConfigured: true, chatDb: db, bots });
      expect(Object.keys(sources).sort()).toEqual(["backgroundAgents", "chatRuns", "cron", "dispatcher", "routines", "terminals"]);
    }
  });
});
