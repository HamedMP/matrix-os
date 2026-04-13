import { describe, it, expect } from "vitest";
import {
  ManifestEntrySchema,
  ManifestSchema,
  PeerInfoSchema,
  ConflictRecordSchema,
  SyncConfigSchema,
  LocalFileStateSchema,
  SyncStateSchema,
  PresignFileSchema,
  PresignRequestSchema,
  CommitFileSchema,
  CommitRequestSchema,
  ResolveConflictSchema,
  ShareRoleSchema,
  CreateShareSchema,
  AcceptShareSchema,
} from "../../../packages/gateway/src/sync/types.js";

describe("ManifestEntrySchema", () => {
  it("accepts a valid entry", () => {
    const entry = {
      hash: "sha256:" + "a".repeat(64),
      size: 4096,
      mtime: 1744540800000,
      peerId: "hamed-macbook",
      version: 3,
    };
    expect(ManifestEntrySchema.parse(entry)).toEqual(entry);
  });

  it("rejects invalid hash format", () => {
    const entry = {
      hash: "md5:abc",
      size: 100,
      mtime: 1000,
      peerId: "peer",
      version: 1,
    };
    expect(() => ManifestEntrySchema.parse(entry)).toThrow();
  });

  it("rejects negative size", () => {
    const entry = {
      hash: "sha256:" + "a".repeat(64),
      size: -1,
      mtime: 1000,
      peerId: "peer",
      version: 1,
    };
    expect(() => ManifestEntrySchema.parse(entry)).toThrow();
  });

  it("accepts optional deleted fields", () => {
    const entry = {
      hash: "sha256:" + "b".repeat(64),
      size: 0,
      mtime: 1744540900000,
      peerId: "hamed-macbook",
      version: 5,
      deleted: true,
      deletedAt: 1744540900000,
    };
    expect(ManifestEntrySchema.parse(entry)).toEqual(entry);
  });
});

describe("ManifestSchema", () => {
  it("accepts a valid manifest", () => {
    const manifest = {
      version: 2 as const,
      files: {
        "apps/calculator/index.html": {
          hash: "sha256:" + "c".repeat(64),
          size: 4096,
          mtime: 1744540800000,
          peerId: "hamed-macbook",
          version: 1,
        },
      },
    };
    expect(ManifestSchema.parse(manifest)).toEqual(manifest);
  });

  it("rejects wrong version", () => {
    const manifest = {
      version: 1,
      files: {},
    };
    expect(() => ManifestSchema.parse(manifest)).toThrow();
  });
});

describe("PresignRequestSchema", () => {
  it("accepts a valid presign request", () => {
    const req = {
      files: [
        { path: "apps/test.txt", action: "put" as const, hash: "sha256:" + "d".repeat(64), size: 100 },
      ],
    };
    expect(PresignRequestSchema.parse(req)).toEqual(req);
  });

  it("rejects empty files array", () => {
    expect(() => PresignRequestSchema.parse({ files: [] })).toThrow();
  });

  it("rejects more than 100 files", () => {
    const files = Array.from({ length: 101 }, (_, i) => ({
      path: `file${i}.txt`,
      action: "get" as const,
    }));
    expect(() => PresignRequestSchema.parse({ files })).toThrow();
  });
});

describe("CommitRequestSchema", () => {
  it("accepts a valid commit request", () => {
    const req = {
      files: [
        { path: "apps/test.txt", hash: "sha256:" + "e".repeat(64), size: 200 },
      ],
      expectedVersion: 5,
    };
    expect(CommitRequestSchema.parse(req)).toEqual(req);
  });
});

describe("ResolveConflictSchema", () => {
  it("accepts valid resolution", () => {
    const res = {
      path: "apps/test.txt",
      resolution: "keep-local" as const,
    };
    expect(ResolveConflictSchema.parse(res)).toEqual(res);
  });

  it("rejects unknown resolution", () => {
    expect(() => ResolveConflictSchema.parse({
      path: "test.txt",
      resolution: "delete-both",
    })).toThrow();
  });
});

describe("ShareRoleSchema", () => {
  it("accepts viewer, editor, admin", () => {
    expect(ShareRoleSchema.parse("viewer")).toBe("viewer");
    expect(ShareRoleSchema.parse("editor")).toBe("editor");
    expect(ShareRoleSchema.parse("admin")).toBe("admin");
  });

  it("rejects unknown roles", () => {
    expect(() => ShareRoleSchema.parse("superadmin")).toThrow();
  });
});

describe("CreateShareSchema", () => {
  it("accepts a valid share creation", () => {
    const share = {
      path: "projects/startup/",
      granteeHandle: "@colleague:matrix-os.com",
      role: "editor" as const,
    };
    expect(CreateShareSchema.parse(share)).toEqual(share);
  });
});

describe("AcceptShareSchema", () => {
  it("accepts a valid UUID", () => {
    const accept = { shareId: "550e8400-e29b-41d4-a716-446655440000" };
    expect(AcceptShareSchema.parse(accept)).toEqual(accept);
  });

  it("rejects non-UUID", () => {
    expect(() => AcceptShareSchema.parse({ shareId: "not-a-uuid" })).toThrow();
  });
});

describe("PeerInfoSchema", () => {
  it("accepts valid peer info", () => {
    const peer = {
      peerId: "hamed-macbook",
      userId: "hamed",
      hostname: "Hameds-MacBook-Pro.local",
      platform: "darwin" as const,
      clientVersion: "0.1.0",
      connectedAt: Date.now(),
    };
    expect(PeerInfoSchema.parse(peer)).toEqual(peer);
  });
});

describe("SyncStateSchema", () => {
  it("accepts valid sync state", () => {
    const state = {
      manifestVersion: 10,
      lastSyncAt: Date.now(),
      files: {
        "test.txt": {
          hash: "sha256:" + "f".repeat(64),
          mtime: Date.now(),
          size: 100,
          lastSyncedHash: "sha256:" + "0".repeat(64),
        },
      },
    };
    expect(SyncStateSchema.parse(state)).toEqual(state);
  });
});
