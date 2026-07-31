import { describe, expect, it } from "vitest";
import { BridgeQueryBodySchema } from "../../packages/gateway/src/app-db-contracts";

describe("BridgeQueryBodySchema", () => {
  it("accepts the complete supported action contract", () => {
    const validBodies = [
      { app: "clock", action: "find", table: "cities", filter: { position: { $gte: 0 } }, orderBy: { position: "asc" }, limit: 20, offset: 0 },
      { app: "clock", action: "findOne", table: "cities", id: "city-1" },
      { app: "clock", action: "insert", table: "cities", data: { city_id: "london" } },
      { app: "clock", action: "bulkInsert", table: "cities", rows: [{ city_id: "london" }] },
      { app: "clock", action: "update", table: "cities", id: "city-1", data: { position: 1 } },
      { app: "clock", action: "bulkUpdate", table: "cities", updates: [{ id: "city-1", data: { position: 1 } }] },
      { app: "clock", action: "delete", table: "cities", id: "city-1" },
      { app: "clock", action: "count", table: "cities", filter: { city_id: "london" } },
      { app: "clock", action: "schema" },
      { app: "clock", action: "appInfo" },
      { action: "listApps" },
    ];

    for (const body of validBodies) {
      expect(BridgeQueryBodySchema.safeParse(body).success).toBe(true);
    }
  });

  it("accepts a bounded bulk insert with non-empty, safe-column rows", () => {
    expect(BridgeQueryBodySchema.safeParse({
      app: "clock",
      action: "bulkInsert",
      table: "cities",
      rows: [
        { city_id: "london", position: 0 },
        { city_id: "tokyo", position: 1 },
      ],
    }).success).toBe(true);
  });

  it("normalizes nested app identities to their registered storage slug", () => {
    const result = BridgeQueryBodySchema.safeParse({
      app: "games/2048",
      action: "find",
      table: "scores",
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.app).toBe("games2048");
  });

  it("rejects malformed bulk inserts at the route contract", () => {
    const invalidBodies = [
      { app: "clock", action: "bulkInsert", table: "cities" },
      { app: "clock", action: "bulkInsert", table: "cities", rows: {} },
      { app: "clock", action: "bulkInsert", table: "cities", rows: [null] },
      { app: "clock", action: "bulkInsert", table: "cities", rows: [{}] },
      { app: "clock", action: "bulkInsert", table: "cities", rows: [{ "bad column": 1 }] },
      {
        app: "clock",
        action: "bulkInsert",
        table: "cities",
        rows: Array.from({ length: 201 }, (_, position) => ({ city_id: String(position) })),
      },
    ];

    for (const body of invalidBodies) {
      expect(BridgeQueryBodySchema.safeParse(body).success).toBe(false);
    }
  });

  it("uses strict per-action payloads", () => {
    expect(BridgeQueryBodySchema.safeParse({
      app: "clock",
      action: "appInfo",
      rows: [{ unexpected: true }],
    }).success).toBe(false);
    expect(BridgeQueryBodySchema.safeParse({
      action: "listApps",
      table: "unexpected",
    }).success).toBe(false);
  });
});
