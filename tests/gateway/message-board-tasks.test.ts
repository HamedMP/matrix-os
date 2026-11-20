import { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BoardActor, BoardEvent } from "@matrix-os/contracts/message-board";
import { bootstrapMessageBoardDatabase, type MessageBoardDatabase } from "../../packages/gateway/src/message-board/database.js";
import { MessageBoardServiceError } from "../../packages/gateway/src/message-board/errors.js";
import { MessageBoardService } from "../../packages/gateway/src/message-board/service.js";
import { BoardTaskService } from "../../packages/gateway/src/message-board/tasks.js";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";

const OWNER = "owner_1";
const owner: BoardActor = { id: "user:owner_1", kind: "user", name: "Owner" };
const fixer: BoardActor = { id: "agent:chat_1", kind: "agent", name: "chat_1", profile: "fixer" };
const reviewer: BoardActor = { id: "agent:term_2", kind: "agent", name: "term_2", profile: "reviewer" };
const guest: BoardActor = { id: "user:guest_9", kind: "user", name: "Guest" };

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    if (error instanceof MessageBoardServiceError) return error.reason;
    throw error;
  }
}

describe("BoardTaskService", () => {
  let db: Kysely<MessageBoardDatabase>;
  let board: MessageBoardService;
  let tasks: BoardTaskService;
  let clock: number;
  let events: BoardEvent[];

  beforeEach(async () => {
    const pglite = await createTestPGlite();
    db = new Kysely<MessageBoardDatabase>({ dialect: pglite.dialect });
    await bootstrapMessageBoardDatabase(db);
    clock = Date.parse("2026-11-20T10:00:00.000Z");
    events = [];
    tasks = BoardTaskService.attach(db, {
      now: () => new Date(clock),
      onEvents: (_owner, batch) => { events.push(...batch); },
      limits: { writesPerMinute: 10_000 },
    });
    board = tasks.board;
  });

  afterEach(async () => db.destroy());

  const as = (actor: BoardActor) => ({ ownerId: OWNER, actor });
  const create = (actor: BoardActor, text: string, options: { needs?: string[]; forProfile?: string; channel?: string } = {}) =>
    tasks.create(as(actor), undefined, { channel: options.channel ?? "dev", text, ...options });

  it("creates a task as a thread with state mirrored to the reserved label", async () => {
    const task = await create(owner, "Fix flaky login test");
    expect(task.task).toMatchObject({ state: "ready", createdBy: owner.id, assignedProfile: null, holder: null, epoch: 0 });
    const thread = await board.getThread(as(owner), undefined, task.root.id);
    expect(thread.root.labels).toEqual({ "board.task": "ready" });
    expect(thread.task?.state).toBe("ready");
    expect(events.map((event) => event.type)).toEqual(["channel.created", "message.posted", "task.created"]);
    const plain = await board.post(as(owner), undefined, { channel: "dev", text: "Idea" });
    await tasks.createFromThread(as(owner), undefined, plain.id, {});
    expect(await reason(tasks.createFromThread(as(owner), undefined, plain.id, {}))).toBe("duplicate_id");
    expect((await board.listThreads(as(owner), undefined, { channel: "dev", taskState: "ready", limit: 50 })).length).toBe(2);
  });

  it("lets exactly one of two racing claims win", async () => {
    const task = await create(owner, "Only one");
    const results = await Promise.allSettled([tasks.claim(as(fixer), undefined, { id: task.root.id }), tasks.claim(as(reviewer), undefined, { id: task.root.id })]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect((loser.reason as MessageBoardServiceError).reason).toBe("task_claimed");
  });

  it("claims the next ready task: assigned to me first, then my owner's, never another creator's unless named", async () => {
    await create(guest, "From a guest");
    await create(owner, "Open to anyone");
    await create(owner, "Only the reviewer", { forProfile: "reviewer" });
    const mine = await tasks.claim(as(reviewer), undefined, { ready: "dev" });
    expect(mine.task.assignedProfile).toBe("reviewer");
    const next = await tasks.claim(as(reviewer), undefined, { ready: "dev" });
    expect((await board.getThread(as(owner), undefined, next.taskId)).root.text).toBe("Open to anyone");
    expect(await reason(tasks.claim(as(reviewer), undefined, { ready: "dev" }))).toBe("nothing_ready");
    const named = await tasks.claim(as(reviewer), undefined, { ready: "dev", from: guest.id });
    expect((await board.getThread(as(owner), undefined, named.taskId)).root.text).toBe("From a guest");
    expect(await reason(tasks.claim(as(reviewer), undefined, { ready: "ops/" }))).toBe("nothing_ready");
    const plain = { id: "agent:term_3", kind: "agent" as const, name: "term_3" };
    const open = await create(owner, "Any agent may take this");
    expect((await tasks.claim(as(plain), undefined, { ready: "dev" })).taskId).toBe(open.root.id);
  });

  it("refuses claims on assigned, waiting, blocked and finished tasks with stable reasons", async () => {
    const assigned = await create(owner, "Reviewer only", { forProfile: "reviewer" });
    expect(await reason(tasks.claim(as(fixer), undefined, { id: assigned.root.id }))).toBe("task_assigned");
    expect(await reason(tasks.claim(as(owner), undefined, { id: assigned.root.id }))).toBe("task_assigned");
    const first = await create(owner, "First");
    const second = await create(owner, "Second", { needs: [first.root.id] });
    expect(second.task.state).toBe("waiting");
    expect(await reason(tasks.claim(as(fixer), undefined, { id: second.root.id }))).toBe("task_waiting");
    await tasks.block(as(owner), undefined, first.root.id, { reason: "Need input", kind: "needs_input" });
    expect(await reason(tasks.claim(as(fixer), undefined, { id: first.root.id }))).toBe("task_blocked");
    await tasks.cancel(as(owner), undefined, first.root.id, { reason: "Dropped" });
    expect(await reason(tasks.claim(as(fixer), undefined, { id: first.root.id }))).toBe("task_finished");
  });

  it("readies dependents when every prerequisite completes, and not when one fails", async () => {
    const fix = await create(owner, "Fix");
    const docs = await create(owner, "Docs");
    const review = await create(owner, "Review", { needs: [fix.root.id, docs.root.id] });
    const fixClaim = await tasks.claim(as(fixer), undefined, { id: fix.root.id });
    await tasks.complete(as(fixer), undefined, fix.root.id, { epoch: fixClaim.epoch, token: fixClaim.token, result: "Merged #3501" });
    expect((await board.getThread(as(owner), undefined, review.root.id)).task?.state).toBe("waiting");
    const docsClaim = await tasks.claim(as(fixer), undefined, { id: docs.root.id });
    await tasks.fail(as(fixer), undefined, docs.root.id, { epoch: docsClaim.epoch, token: docsClaim.token, reason: "No access" });
    expect((await board.getThread(as(owner), undefined, review.root.id)).task?.state).toBe("waiting");
    await tasks.reopen(as(owner), undefined, docs.root.id);
    const again = await tasks.claim(as(fixer), undefined, { id: docs.root.id });
    expect(again.epoch).toBe(docsClaim.epoch + 1);
    await tasks.complete(as(fixer), undefined, docs.root.id, { epoch: again.epoch, token: again.token });
    const thread = await board.getThread(as(owner), undefined, review.root.id);
    expect(thread.task?.state).toBe("ready");
    expect(thread.needs.map((need) => need.state)).toEqual(["completed", "completed"]);
    expect(events.filter((event) => event.type === "task.ready").map((event) => event.messageId)).toEqual([review.root.id]);
    expect((await board.getThread(as(owner), undefined, fix.root.id)).task?.result).toBe("Merged #3501");
  });

  it("returns a lapsed claim to ready and refuses the old holder with claim_lost", async () => {
    const task = await create(owner, "Lease me");
    const claim = await tasks.claim(as(fixer), undefined, { id: task.root.id, leaseSeconds: 60 });
    clock += 30_000;
    await tasks.renew(as(fixer), undefined, task.root.id, { epoch: claim.epoch, token: claim.token, leaseSeconds: 60 });
    clock += 50_000;
    expect(await tasks.sweepExpiredLeases()).toBe(0);
    clock += 20_000;
    expect(await tasks.sweepExpiredLeases()).toBe(1);
    expect((await board.getThread(as(owner), undefined, task.root.id)).task).toMatchObject({ state: "ready", holder: null, leaseUntil: null });
    expect(events.at(-1)).toMatchObject({ type: "task.expired", messageId: task.root.id });
    expect(await reason(tasks.complete(as(fixer), undefined, task.root.id, { epoch: claim.epoch, token: claim.token }))).toBe("claim_lost");
    const next = await tasks.claim(as(reviewer), undefined, { id: task.root.id });
    expect(await reason(tasks.renew(as(fixer), undefined, task.root.id, { epoch: claim.epoch, token: claim.token }))).toBe("claim_lost");
    expect(await reason(tasks.complete(as(reviewer), undefined, task.root.id, { epoch: next.epoch, token: "0".repeat(64) }))).toBe("claim_lost");
    expect(await reason(tasks.complete(as(reviewer), undefined, task.root.id, {}))).toBe("invalid_input");
    expect(await reason(tasks.complete(as(owner), undefined, task.root.id, {}))).toBe("claim_not_held");
  });

  it("lets a person settle their own claim without a token, and blocks, unblocks and releases", async () => {
    const task = await create(owner, "Mine");
    await tasks.claim(as(owner), undefined, { id: task.root.id });
    await tasks.release(as(owner), undefined, task.root.id, {});
    await tasks.claim(as(owner), undefined, { id: task.root.id });
    await tasks.block(as(owner), undefined, task.root.id, { reason: "Waiting on finance", kind: "needs_input" });
    expect((await board.getThread(as(owner), undefined, task.root.id)).task).toMatchObject({ state: "blocked", blockedKind: "needs_input", holder: null });
    await tasks.unblock(as(owner), undefined, task.root.id);
    expect((await board.getThread(as(owner), undefined, task.root.id)).task?.state).toBe("ready");
    expect((await board.getThread(as(owner), undefined, task.root.id)).root.labels["board.task"]).toBe("ready");
  });

  it("assigns, replaces prerequisites, and keeps cancel to the creator or the owner", async () => {
    const task = await create(fixer, "Agent task");
    const other = await create(owner, "Other");
    await tasks.assign(as(owner), undefined, task.root.id, { profile: "reviewer" });
    expect((await board.getThread(as(owner), undefined, task.root.id)).task?.assignedProfile).toBe("reviewer");
    await tasks.assign(as(owner), undefined, task.root.id, { profile: null });
    await tasks.setNeeds(as(owner), undefined, task.root.id, { needs: [other.root.id] });
    expect((await board.getThread(as(owner), undefined, task.root.id)).task?.state).toBe("waiting");
    expect(await reason(tasks.setNeeds(as(owner), undefined, task.root.id, { needs: [task.root.id] }))).toBe("invalid_needs");
    expect(await reason(tasks.setNeeds(as(owner), undefined, task.root.id, { needs: ["msg_notatask00001"] }))).toBe("invalid_needs");
    expect(await reason(tasks.setNeeds(as(owner), undefined, other.root.id, { needs: [task.root.id] }))).toBe("invalid_needs");
    expect(await reason(tasks.cancel(as(reviewer), undefined, task.root.id, { reason: "no" }))).toBe("task_not_owned");
    await tasks.cancel(as(fixer), undefined, task.root.id, { reason: "Not needed" });
    expect((await board.getThread(as(owner), undefined, task.root.id)).task).toMatchObject({ state: "canceled", cancelReason: "Not needed" });
  });

  it("creates a plan all or none, resolving plan keys and refusing cycles", async () => {
    const created = await tasks.createPlan(as(owner), undefined, { channel: "projects/matrix-os", tasks: [
      { key: "fix", text: "Fix it" },
      { key: "review", text: "Review it", needs: ["fix"], forProfile: "reviewer" },
    ] });
    expect(created.map((item) => item.task.state)).toEqual(["ready", "waiting"]);
    expect(created[1]!.task.needs).toEqual([created[0]!.root.id]);
    const before = (await board.listThreads(as(owner), undefined, { channel: "*", limit: 50 })).length;
    expect(await reason(tasks.createPlan(as(owner), undefined, { channel: "dev", tasks: [
      { key: "a", text: "A", needs: ["b"] }, { key: "b", text: "B", needs: ["a"] },
    ] }))).toBe("invalid_needs");
    expect(await reason(tasks.createPlan(as(owner), undefined, { channel: "dev", tasks: [{ key: "a", text: "A", needs: ["missing"] }] }))).toBe("invalid_needs");
    expect((await board.listThreads(as(owner), undefined, { channel: "*", limit: 50 })).length).toBe(before);
  });

  it("claims with a server-side wait once a task becomes ready", async () => {
    const pending = tasks.claim(as(fixer), undefined, { ready: "dev", waitSeconds: 2 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const task = await create(owner, "Arrives later");
    const claim = await pending;
    expect(claim.taskId).toBe(task.root.id);
  });
});
