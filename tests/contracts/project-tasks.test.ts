import { describe, expect, it } from "vitest";
import {
  CreateTaskBodySchema, ListTasksQuerySchema, MoveTaskBodySchema, TaskRankSchema, TaskSessionRefSchema, UpdateTaskBodySchema,
  formatTaskKey, rankBetween, spreadRanks,
} from "../../packages/contracts/src/project-tasks.js";

describe("task ranks", () => {
  it("orders a new rank strictly between its neighbours", () => {
    const cases: Array<[string | null, string | null]> = [[null, null], [null, "a"], ["a", null], ["a", "b"], ["a", "a1"], ["az", "b"], ["Zz", "a"]];
    for (const [before, after] of cases) {
      const rank = rankBetween(before, after);
      expect(TaskRankSchema.safeParse(rank).success).toBe(true);
      if (before !== null) expect(rank > before).toBe(true);
      if (after !== null) expect(rank < after).toBe(true);
    }
  });

  it("keeps room at the top of a column and between two neighbours", () => {
    let top = rankBetween(null, null);
    let low = "a";
    for (let index = 0; index < 200; index += 1) {
      const next = rankBetween(null, top);
      expect(next < top).toBe(true);
      top = next;
      const mid = rankBetween(low, "b");
      expect(mid > low && mid < "b").toBe(true);
      low = mid;
    }
  });

  it("rejects neighbours out of order and malformed ranks", () => {
    expect(() => rankBetween("b", "a")).toThrow("rank_order");
    expect(() => rankBetween("a0", null)).toThrow("invalid_rank");
  });

  it("spreads a large import into short ranks in order", () => {
    const ranks = spreadRanks(5000);
    expect(ranks).toHaveLength(5000);
    expect(ranks.every((rank, index) => index === 0 || rank > ranks[index - 1]!)).toBe(true);
    expect(Math.max(...ranks.map((rank) => rank.length))).toBeLessThanOrEqual(4);
    expect(ranks.every((rank) => TaskRankSchema.safeParse(rank).success)).toBe(true);
    expect(spreadRanks(0)).toEqual([]);
  });
});

describe("request schemas", () => {
  it("never accepts an actor or unknown field from a body", () => {
    expect(CreateTaskBodySchema.safeParse({ title: "x", clientRequestId: "req_1", createdBy: "user:me" }).success).toBe(false);
    expect(UpdateTaskBodySchema.safeParse({ baseRevision: 1, revision: 9 }).success).toBe(false);
    expect(MoveTaskBodySchema.safeParse({ status: "done", actor: "user:x" }).success).toBe(false);
  });

  it("bounds titles, labels and list queries", () => {
    expect(CreateTaskBodySchema.safeParse({ title: " ", clientRequestId: "req_1" }).success).toBe(false);
    expect(CreateTaskBodySchema.safeParse({ title: "x".repeat(301), clientRequestId: "req_1" }).success).toBe(false);
    expect(CreateTaskBodySchema.safeParse({ title: "ok", clientRequestId: "req_1", labels: Array(21).fill("a") }).success).toBe(false);
    expect(CreateTaskBodySchema.safeParse({ title: "ok", clientRequestId: "req_1", labels: ["a,b"] }).success).toBe(false);
    expect(ListTasksQuerySchema.parse({})).toMatchObject({ limit: 200, includeArchived: false });
    expect(ListTasksQuerySchema.safeParse({ limit: "501" }).success).toBe(false);
    expect(ListTasksQuerySchema.parse({ includeArchived: "true", limit: "5" })).toMatchObject({ includeArchived: true, limit: 5 });
  });

  it("accepts only chat and terminal tab session refs", () => {
    expect(TaskSessionRefSchema.safeParse("chat_abc").success).toBe(true);
    expect(TaskSessionRefSchema.safeParse("term.tws_1.tt_2").success).toBe(true);
    expect(TaskSessionRefSchema.safeParse("term.../etc").success).toBe(false);
  });

  it("formats display keys", () => {
    expect(formatTaskKey("MOS", 42)).toBe("MOS-42");
  });
});
