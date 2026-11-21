import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalChatMessage, CanonicalChatRun, CanonicalChatTurn } from "@matrix-os/contracts";
import { sql } from "kysely";
import {
  createClaudeNativeRecoveryStore, verifyClaudeNativeRecoveryGeneration, type ClaudeNativeRecoveryInput,
} from "../../packages/gateway/src/chat/claude-native-recovery-store.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createCollaborationTestDatabase, createRealCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";

const owner = { type: "personal", ownerId: "owner_native_cron" } as const;
const selection = { instanceId: "claude_code_default", model: "claude-haiku-4-5-20251001" };
const start = Date.parse("2026-11-11T00:00:00.000Z");
const timestamp = new Date(start).toISOString();
const sessionId = "66a1f859-6832-494b-850b-de12ba965416";
const input: ClaudeNativeRecoveryInput = {
  ownerId: owner.ownerId,
  chatId: "chat_native_recovery",
  sessionId,
  sourceRunId: "run_source",
  sourceFingerprint: "a".repeat(64),
  deadlineAt: new Date(start + 60_000).toISOString(),
  jobs: [{ id: "abcd1234", cron: "* * * * *", promptSha256: "b".repeat(64), recurring: false,
    assistantUuid: "f8b6738b-c7e7-4fb7-b3d5-3794fbd4f5d5", receiptUuid: "4f6fbec3-8756-4b59-8b93-811f1210f643" }],
};

describe("Claude native recovery receipts", () => {
  let fixture: CollaborationTestDatabase;
  let repository: ChatRepository;
  let store: ReturnType<typeof createClaudeNativeRecoveryStore>;
  let now: number;
  beforeEach(async () => {
    fixture = await (process.env.MATRIX_TEST_POSTGRES_URL
      ? createRealCollaborationTestDatabase()
      : createCollaborationTestDatabase());
    repository = new ChatRepository(fixture.db);
    await repository.bootstrap();
    now = start;
    store = createClaudeNativeRecoveryStore(fixture.db, { now: () => new Date(now) });
    await repository.create(owner, { id: input.chatId, clientRequestId: "req_create", title: "Native Cron recovery" });
    await admit("source", 1);
  });
  afterEach(async () => { await fixture?.destroy(); });

  async function admit(suffix: string, seq: number, nativeSessionId = sessionId) {
    const turnId = `cturn_${suffix}`, messageId = `msg_${suffix}`;
    const message: CanonicalChatMessage = { id: messageId, chatId: input.chatId, seq, role: "user",
      purpose: "ai_request", state: "committed", turnId, parts: [{ type: "text", text: "Schedule this task." }], createdAt: timestamp };
    const turn: CanonicalChatTurn = { id: turnId, chatId: input.chatId, clientRequestId: `req_${suffix}`,
      baseMessageSeq: seq - 1, inputMessageId: messageId, status: "accepted", createdAt: timestamp, updatedAt: timestamp };
    const run: CanonicalChatRun = { id: `run_${suffix}`, chatId: input.chatId, turnId, attempt: 1,
      driverKind: "claude_code", instanceId: selection.instanceId, selection, interactionMode: "default",
      permissionMode: "supervised", status: "accepted", historyBoundarySeq: seq - 1, capabilitySnapshot: {
        revision: "catalog_native_cron", rootChat: true, attachments: [], resources: [], tools: [], approvals: true,
        userInput: true, resume: true, cancellation: true, steering: "same_run", worktrees: "optional",
        interactionModes: ["default"], permissionModes: ["supervised"],
      }, createdAt: timestamp, updatedAt: timestamp };
    const baseRevision = (await repository.get(owner, input.chatId))!.chat.revision;
    await repository.admitTurn(owner, { chatId: input.chatId, baseRevision, message, turn, run });
    await repository.updateAdapterState(owner, { chatId: input.chatId, runId: run.id, driverKind: "claude_code",
      instanceId: selection.instanceId, schemaVersion: 1, state: { sessionId: nativeSessionId } });
  }

  async function finish(runId = input.sourceRunId) {
    await repository.finishRun(owner, { chatId: input.chatId, runId, outcome: "completed", completedAt: timestamp });
  }

  it("persists during the current phase, but only exposes a confirmed closed handoff", async () => {
    const active = (await store.saveActive(input))!;
    expect(active).toMatchObject({ generation: 1, status: "active" });
    expect(await store.listRecoverable(owner.ownerId)).toEqual([]);
    expect(await store.release(active)).toBeNull();
    await finish();
    const released = (await store.release(active))!;
    expect(released).toMatchObject({ generation: 2, status: "released" });
    expect(await store.listRecoverable(owner.ownerId)).toEqual([released]);
    expect(await store.listRecoverable("different_owner")).toEqual([]);
    expect(await store.claim(active)).toBeNull();
    const claimed = (await store.claim(released))!;
    expect(claimed).toMatchObject({ generation: 3, status: "active" });
    expect(await store.claim(released)).toBeNull();
    expect(await store.invalidate(active)).toBeNull();
    expect(await store.listRecoverable(owner.ownerId)).toEqual([]);
  });

  it("allows one claimant and keeps stale-generation one-shot receipts from being replayed", async () => {
    const active = (await store.saveActive(input))!;
    await finish();
    const released = (await store.release(active))!;
    const claims = await Promise.all([store.claim(released), store.claim(released)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claimed = claims.find(candidate => candidate !== null)!;
    expect(await store.consume(released, input.jobs[0]!.id)).toBeNull();
    const consumed = await store.consume(claimed, input.jobs[0]!.id);
    expect(consumed).toMatchObject({ status: "invalid", jobs: [], generation: claimed.generation + 1 });
    expect(await store.consume(claimed, input.jobs[0]!.id)).toBeNull();
  });

  it("validates source, owner and original deadline under the write fence", async () => {
    expect(await store.saveActive({ ...input, ownerId: "different_owner" })).toBeNull();
    expect(await store.saveActive({ ...input, sessionId: "2e9027cf-f8e9-44c5-98ec-13b5d002793f" })).toBeNull();
    const active = (await store.saveActive(input))!;
    expect(await store.saveActive({ ...input, deadlineAt: new Date(start + 90_000).toISOString() }, active.generation)).toBeNull();
    expect(await store.saveActive({ ...input, sourceFingerprint: "c".repeat(64) }, active.generation)).toBeNull();
    await finish();
    await admit("second", 2);
    expect(await store.release(active)).toBeNull();
    const next = (await store.saveActive({ ...input, sourceRunId: "run_second" }, active.generation))!;
    expect(next).toMatchObject({ sourceRunId: "run_second", generation: active.generation + 1 });
    await finish("run_second");
    const released = (await store.release(next))!;
    now = start + 60_000;
    expect(await store.listRecoverable(owner.ownerId)).toEqual([]);
    expect(await store.claim(released)).toBeNull();
  });

  it.each(["active", "released"] as const)("allows a new native session to supersede a stale %s generation", async (status) => {
    const active = (await store.saveActive(input))!;
    await finish();
    const stale = status === "released" ? (await store.release(active))! : active;
    await admit("same_session", 2);
    await finish("run_same_session");
    expect(await store.saveActive({ ...input, sourceRunId: "run_same_session" })).toBeNull();

    const nextSession = "2e9027cf-f8e9-44c5-98ec-13b5d002793f";
    await admit("new_session", 3, nextSession);
    await finish("run_new_session");
    const snapshot = { ...input, sessionId: nextSession, sourceRunId: "run_new_session" };
    const replacements = await Promise.all([store.saveActive(snapshot), store.saveActive(snapshot)]);
    expect(replacements.filter(Boolean)).toHaveLength(1);
    const next = replacements.find(candidate => candidate !== null);
    expect(next).toMatchObject({ sessionId: nextSession, status: "active", generation: stale.generation + 1 });
    expect(await store.claim(stale)).toBeNull();
    expect(await store.release(stale)).toBeNull();
    expect(await store.release(next!)).toMatchObject({ sessionId: nextSession, status: "released" });
  });

  it("refuses recovery after a checkpoint or private Chat binding changes", async () => {
    const active = (await store.saveActive(input))!;
    await finish();
    const released = (await store.release(active))!;
    await fixture.db.updateTable("chat_run_adapter_state").set({
      state: sql`${JSON.stringify({ sessionId: "other" })}::jsonb`,
    }).where("run_id", "=", input.sourceRunId).execute();
    expect(await store.claim(released)).toBeNull();
    await fixture.db.updateTable("chat_run_adapter_state").set({
      state: sql`${JSON.stringify({ sessionId })}::jsonb`,
    }).where("run_id", "=", input.sourceRunId).execute();
    await fixture.db.updateTable("chats").set({ collaboration: sql`'{}'::jsonb` })
      .where("id", "=", input.chatId).execute();
    expect(await store.claim(released)).toBeNull();
    expect(await store.invalidate(released)).toMatchObject({ status: "invalid", jobs: [] });
  });

  it("does not list a released source superseded by a newer canonical run", async () => {
    const active = (await store.saveActive(input))!;
    await finish();
    const released = await store.release(active);
    expect(await store.listRecoverable(owner.ownerId)).toEqual([released]);
    await admit("newer", 2);
    await finish("run_newer");
    expect(await store.listRecoverable(owner.ownerId)).toEqual([]);
    expect(await store.claim(released!)).toBeNull();
  });

  it("rejects raw prompt fields and ambiguous job definitions", async () => {
    await expect(store.saveActive({ ...input, jobs: [{ ...input.jobs[0]!, prompt: "secret" } as never] })).rejects.toThrow();
    await expect(store.saveActive({ ...input, jobs: [...input.jobs, { ...input.jobs[0]!, id: "dcba4321" }] })).rejects.toThrow();
    expect(await store.listRecoverable(owner.ownerId)).toEqual([]);
  });

  it("seals the bounded wire receipt in Postgres and restores it only with the same owner key", async () => {
    const recoveryKey = Buffer.alloc(32, 21);
    const trusted = createClaudeNativeRecoveryStore(fixture.db, { now: () => new Date(now), recoveryKey });
    const prompt = "Synthetic schedule input with private context";
    const recurring = { ...input.jobs[0]!, recurring: true,
      promptSha256: createHash("sha256").update(prompt).digest("hex"),
      replay: { toolUseId: "toolu_fixture", assistantMessageId: "msg_fixture", prompt,
        receivedAtMs: start, nextFireAtMs: start + 30_000 } };
    const checkpoint = { ...input, jobs: [recurring] };
    expect(await store.saveActive(checkpoint)).toBeNull();
    expect(await trusted.saveActive({ ...checkpoint, jobs: [{ ...recurring, promptSha256: "c".repeat(64) }] })).toBeNull();
    const active = (await trusted.saveActive(checkpoint))!;
    expect(active.jobs).toEqual([recurring]);
    const persisted = await fixture.db.selectFrom("chat_claude_native_recovery").select("jobs").executeTakeFirstOrThrow();
    expect(JSON.stringify(persisted.jobs)).not.toContain(prompt);
    await finish();
    const released = (await trusted.release(active))!;
    expect(await store.listRecoverable(owner.ownerId)).toEqual([]);
    const wrongKey = createClaudeNativeRecoveryStore(fixture.db, { now: () => new Date(now), recoveryKey: Buffer.alloc(32, 22) });
    expect(await wrongKey.listRecoverable(owner.ownerId)).toEqual([]);
    expect(await wrongKey.claim(released)).toBeNull();
    expect(await trusted.listRecoverable(owner.ownerId)).toEqual([released]);
    expect(await trusted.claim(released)).toMatchObject({ jobs: [recurring], status: "active" });
  });

  it.each([[1, 4_000, "job"], [10, 3_100, "receipt"]] as const)(
    "reports when %i jobs of %i characters exceed the %s limit", async (count, length, limit) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const trusted = createClaudeNativeRecoveryStore(fixture.db, { now: () => new Date(now), recoveryKey: Buffer.alloc(32, 21) });
        const jobs = Array.from({ length: count }, (_, i) => {
          const prompt = "private recovery prompt".padEnd(length, String(i));
          return { ...input.jobs[0]!, id: i.toString(16).padStart(8, "0"), recurring: true,
            assistantUuid: randomUUID(), receiptUuid: randomUUID(), promptSha256: createHash("sha256").update(prompt).digest("hex"),
            replay: { toolUseId: `toolu_${i}`, assistantMessageId: `msg_${i}`, prompt,
              receivedAtMs: start, nextFireAtMs: start + 30_000 } };
        });
        expect(await trusted.saveActive({ ...input, jobs })).toBeNull();
        expect(warn.mock.calls).toEqual([[`[claude-native] Recovery skipped: replay ${limit} size limit`]]);
        expect(await fixture.db.selectFrom("chat_claude_native_recovery").select("chat_id").execute()).toEqual([]);
      } finally {
        warn.mockRestore();
      }
    },
  );

  it("validates the current process generation and bound job inside an admission transaction", async () => {
    const active = (await store.saveActive(input))!;
    await finish();
    const released = (await store.release(active))!;
    const claimed = (await store.claim(released))!;
    const fence = { ownerId: claimed.ownerId, chatId: claimed.chatId, sessionId: claimed.sessionId,
      sourceRunId: claimed.sourceRunId, sourceFingerprint: claimed.sourceFingerprint,
      generation: claimed.generation, jobId: claimed.jobs[0]!.id, promptSha256: claimed.jobs[0]!.promptSha256 };
    const verify = (override = {}) => fixture.db.transaction().execute(async trx => {
      await trx.selectFrom("chats").select("id").where("id", "=", input.chatId).forUpdate().executeTakeFirstOrThrow();
      return verifyClaudeNativeRecoveryGeneration(trx, { ...fence, ...override }, new Date(now));
    });
    expect(await verify()).toBe(true);
    expect(await verify({ generation: active.generation })).toBe(false);
    expect(await verify({ promptSha256: "c".repeat(64) })).toBe(false);
    expect(await verify({ sourceRunId: "run_other" })).toBe(false);
    expect(await verify({ ownerId: "other_owner" })).toBe(false);
    now = start + 60_000;
    expect(await verify()).toBe(false);
  });
});
