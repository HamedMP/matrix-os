import { describe, expect, it } from "vitest";
import {
  buildSyncScopePrefix,
  deriveHomeMirrorSyncIdentity,
  resolveSyncScope,
} from "../../../packages/gateway/src/sync/runtime-scope.js";

describe("resolveSyncScope", () => {
  it("keeps the primary runtime on the compatible owner prefix", () => {
    const scope = resolveSyncScope({ ownerId: "user_123", runtimeSlot: "primary" });

    expect(scope).toEqual({ ownerId: "user_123", runtimeSlot: "primary" });
    expect(buildSyncScopePrefix(scope)).toBe("matrixos-sync/user_123");
  });

  it("uses a versioned namespace for a non-primary runtime", () => {
    const scope = resolveSyncScope({ ownerId: "user_123", runtimeSlot: "staging" });

    expect(buildSyncScopePrefix(scope)).toBe(
      "matrixos-sync/v2/owners/user_123/runtimes/staging",
    );
  });

  it("does not merge two slots owned by the same account", () => {
    const primary = buildSyncScopePrefix(resolveSyncScope({
      ownerId: "user_123",
      runtimeSlot: "primary",
    }));
    const secondary = buildSyncScopePrefix(resolveSyncScope({
      ownerId: "user_123",
      runtimeSlot: "studio",
    }));

    expect(primary).not.toBe(secondary);
  });
});

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
