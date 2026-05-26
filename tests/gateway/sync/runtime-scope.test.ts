import { describe, expect, it } from "vitest";
import { deriveHomeMirrorSyncIdentity } from "../../../packages/gateway/src/sync/runtime-scope.js";

describe("deriveHomeMirrorSyncIdentity", () => {
  it("keeps primary home mirror state on the existing owner key", () => {
    expect(deriveHomeMirrorSyncIdentity({
      baseUserId: "user_39ixbMSmVwyefl6i8HSTO8H2KWx",
      runtimeSlot: "primary",
    })).toEqual({
      syncUserId: "user_39ixbMSmVwyefl6i8HSTO8H2KWx",
      peerId: "gateway-user_39ixbMSmVwyefl6i8HSTO8H2KWx",
    });
  });

  it("scopes non-primary home mirror state by runtime slot", () => {
    expect(deriveHomeMirrorSyncIdentity({
      baseUserId: "user_39ixbMSmVwyefl6i8HSTO8H2KWx",
      runtimeSlot: "staging",
    })).toEqual({
      syncUserId: "user_39ixbMSmVwyefl6i8HSTO8H2KWx__slot_staging",
      peerId: "gateway-user_39ixbMSmVwyefl6i8HSTO8H2KWx__slot_staging",
    });
  });

  it("keeps derived peer ids inside the sync peer schema limit", () => {
    const identity = deriveHomeMirrorSyncIdentity({
      baseUserId: "u".repeat(256),
      runtimeSlot: "elixir-symphony",
    });

    expect(identity.syncUserId).toHaveLength(256);
    expect(identity.peerId.length).toBeLessThanOrEqual(128);
    expect(identity.syncUserId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(identity.peerId).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("rejects invalid runtime slots before they become object keys", () => {
    expect(() => deriveHomeMirrorSyncIdentity({
      baseUserId: "user_123",
      runtimeSlot: "../primary",
    })).toThrow(/Invalid MATRIX_RUNTIME_SLOT/);
  });
});
