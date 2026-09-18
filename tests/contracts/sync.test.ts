import { describe, expect, it } from "vitest";
import {
  SyncRuntimeSlotSchema,
  SyncScopeSchema,
} from "../../packages/contracts/src/index.js";

describe("sync contracts", () => {
  it("accepts a bounded owner and runtime scope", () => {
    expect(SyncScopeSchema.parse({
      ownerId: "user_123",
      runtimeSlot: "primary",
    })).toEqual({
      ownerId: "user_123",
      runtimeSlot: "primary",
    });
  });

  it.each([
    "../primary",
    "UPPERCASE",
    "-leading",
    "trailing-",
    "a".repeat(33),
  ])("rejects unsafe runtime slot %j", (runtimeSlot) => {
    expect(SyncRuntimeSlotSchema.safeParse(runtimeSlot).success).toBe(false);
  });

  it("rejects owner identifiers that cannot safely enter an object key", () => {
    expect(SyncScopeSchema.safeParse({
      ownerId: "owner/other",
      runtimeSlot: "primary",
    }).success).toBe(false);
  });
});
