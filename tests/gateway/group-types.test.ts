import { describe, it, expect } from "vitest";
import {
  GroupManifestSchema,
  GroupAclSchema,
  OpEventContentSchema,
  SnapshotEventContentSchema,
  SnapshotLeaseContentSchema,
  GroupDataValueSchema,
  GroupDataRequestSchema,
  GROUP_SLUG_REGEX,
  MEMBER_HANDLE_REGEX,
} from "../../packages/gateway/src/group-types.js";

// ── GroupManifest ─────────────────────────────────────────────────────────────

describe("GroupManifestSchema", () => {
  const valid = {
    room_id: "!abc123:matrix-os.com",
    name: "Schmidt Family",
    slug: "schmidt-family",
    owner_handle: "@hamed:matrix-os.com",
    joined_at: 1712780000000,
    schema_version: 1,
  };

  it("accepts a valid manifest", () => {
    expect(() => GroupManifestSchema.parse(valid)).not.toThrow();
  });

  it("requires room_id", () => {
    expect(() => GroupManifestSchema.parse({ ...valid, room_id: undefined })).toThrow();
  });

  it("requires name", () => {
    expect(() => GroupManifestSchema.parse({ ...valid, name: undefined })).toThrow();
  });

  it("requires slug", () => {
    expect(() => GroupManifestSchema.parse({ ...valid, slug: undefined })).toThrow();
  });

  it("requires owner_handle", () => {
    expect(() => GroupManifestSchema.parse({ ...valid, owner_handle: undefined })).toThrow();
  });

  it("requires joined_at", () => {
    expect(() => GroupManifestSchema.parse({ ...valid, joined_at: undefined })).toThrow();
  });

  it("requires schema_version", () => {
    expect(() => GroupManifestSchema.parse({ ...valid, schema_version: undefined })).toThrow();
  });
});

// ── GroupAcl ──────────────────────────────────────────────────────────────────

describe("GroupAclSchema", () => {
  const valid = {
    read_pl: 0,
    write_pl: 50,
    install_pl: 100,
    policy: "open" as const,
  };

  it("accepts a valid ACL", () => {
    expect(() => GroupAclSchema.parse(valid)).not.toThrow();
  });

  it("accepts all policy values", () => {
    for (const policy of ["open", "moderated", "owner_only"]) {
      expect(() => GroupAclSchema.parse({ ...valid, policy })).not.toThrow();
    }
  });

  it("rejects unknown policy", () => {
    expect(() => GroupAclSchema.parse({ ...valid, policy: "public" })).toThrow();
  });

  it("requires read_pl", () => {
    expect(() => GroupAclSchema.parse({ ...valid, read_pl: undefined })).toThrow();
  });

  it("requires write_pl", () => {
    expect(() => GroupAclSchema.parse({ ...valid, write_pl: undefined })).toThrow();
  });

  it("requires install_pl", () => {
    expect(() => GroupAclSchema.parse({ ...valid, install_pl: undefined })).toThrow();
  });

  it("requires policy", () => {
    expect(() => GroupAclSchema.parse({ ...valid, policy: undefined })).toThrow();
  });
});

// ── OpEventContent ────────────────────────────────────────────────────────────

describe("OpEventContentSchema", () => {
  const validSingle = {
    v: 1,
    update: "aGVsbG8=",
    lamport: 4823,
    client_id: "h7g3abc",
    origin: "@hamed:matrix-os.com",
    ts: 1712780000000,
  };

  it("accepts a valid single-event op (no chunk_seq)", () => {
    expect(() => OpEventContentSchema.parse(validSingle)).not.toThrow();
  });

  // Valid ULID: 26 chars from Crockford Base32 (0-9, A-Z excluding I, L, O, U)
  const VALID_ULID = "01HXYZ1234567890ABCDEFGHJK";

  it("accepts a fragmented-event op with chunk_seq", () => {
    const fragmented = {
      ...validSingle,
      chunk_seq: { index: 0, count: 3, group_id: VALID_ULID },
    };
    expect(() => OpEventContentSchema.parse(fragmented)).not.toThrow();
  });

  it("accepts chunk_seq with index at count-1", () => {
    const fragmented = {
      ...validSingle,
      chunk_seq: { index: 2, count: 3, group_id: VALID_ULID },
    };
    expect(() => OpEventContentSchema.parse(fragmented)).not.toThrow();
  });

  it("rejects chunk_seq where index >= count", () => {
    const bad = {
      ...validSingle,
      chunk_seq: { index: 3, count: 3, group_id: VALID_ULID },
    };
    expect(() => OpEventContentSchema.parse(bad)).toThrow();
  });

  it("rejects chunk_seq where index equals count", () => {
    const bad = {
      ...validSingle,
      chunk_seq: { index: 5, count: 5, group_id: VALID_ULID },
    };
    expect(() => OpEventContentSchema.parse(bad)).toThrow();
  });

  it("rejects chunk_seq where count > 32", () => {
    const bad = {
      ...validSingle,
      chunk_seq: { index: 0, count: 33, group_id: VALID_ULID },
    };
    expect(() => OpEventContentSchema.parse(bad)).toThrow();
  });

  it("accepts chunk_seq where count == 32 (boundary)", () => {
    const boundary = {
      ...validSingle,
      chunk_seq: { index: 0, count: 32, group_id: VALID_ULID },
    };
    expect(() => OpEventContentSchema.parse(boundary)).not.toThrow();
  });

  it("rejects chunk_seq with non-ULID group_id", () => {
    const bad = {
      ...validSingle,
      chunk_seq: { index: 0, count: 2, group_id: "not-a-ulid" },
    };
    expect(() => OpEventContentSchema.parse(bad)).toThrow();
  });

  it("chunk_seq is optional — omitting it keeps the single-event shape valid", () => {
    const parsed = OpEventContentSchema.parse(validSingle);
    expect(parsed.chunk_seq).toBeUndefined();
  });

  it("requires v", () => {
    expect(() => OpEventContentSchema.parse({ ...validSingle, v: undefined })).toThrow();
  });

  it("requires update", () => {
    expect(() => OpEventContentSchema.parse({ ...validSingle, update: undefined })).toThrow();
  });

  it("requires lamport", () => {
    expect(() => OpEventContentSchema.parse({ ...validSingle, lamport: undefined })).toThrow();
  });

  it("requires client_id", () => {
    expect(() => OpEventContentSchema.parse({ ...validSingle, client_id: undefined })).toThrow();
  });

  it("requires origin", () => {
    expect(() => OpEventContentSchema.parse({ ...validSingle, origin: undefined })).toThrow();
  });

  it("requires ts", () => {
    expect(() => OpEventContentSchema.parse({ ...validSingle, ts: undefined })).toThrow();
  });
});

// ── SnapshotEventContent ──────────────────────────────────────────────────────

describe("SnapshotEventContentSchema", () => {
  const valid = {
    v: 1,
    snapshot_id: "01HXYZ1234567890ABCDEFGHJK",
    generation: 4823,
    chunk_index: 0,
    chunk_count: 3,
    state: "aGVsbG8=",
    taken_at_event_id: "$abc123:matrix-os.com",
    taken_at: 1712780000000,
    written_by: "@hamed:matrix-os.com",
  };

  it("accepts a valid snapshot event", () => {
    expect(() => SnapshotEventContentSchema.parse(valid)).not.toThrow();
  });

  it("requires v", () => {
    expect(() => SnapshotEventContentSchema.parse({ ...valid, v: undefined })).toThrow();
  });

  it("requires snapshot_id", () => {
    expect(() => SnapshotEventContentSchema.parse({ ...valid, snapshot_id: undefined })).toThrow();
  });

  it("requires generation", () => {
    expect(() => SnapshotEventContentSchema.parse({ ...valid, generation: undefined })).toThrow();
  });

  it("requires chunk_index", () => {
    expect(() => SnapshotEventContentSchema.parse({ ...valid, chunk_index: undefined })).toThrow();
  });

  it("requires chunk_count", () => {
    expect(() => SnapshotEventContentSchema.parse({ ...valid, chunk_count: undefined })).toThrow();
  });

  it("requires state", () => {
    expect(() => SnapshotEventContentSchema.parse({ ...valid, state: undefined })).toThrow();
  });

  it("requires taken_at_event_id", () => {
    expect(() => SnapshotEventContentSchema.parse({ ...valid, taken_at_event_id: undefined })).toThrow();
  });

  it("requires taken_at", () => {
    expect(() => SnapshotEventContentSchema.parse({ ...valid, taken_at: undefined })).toThrow();
  });

  it("requires written_by", () => {
    expect(() => SnapshotEventContentSchema.parse({ ...valid, written_by: undefined })).toThrow();
  });
});

// ── SnapshotLeaseContent ──────────────────────────────────────────────────────

describe("SnapshotLeaseContentSchema", () => {
  const valid = {
    v: 1,
    writer: "@hamed:matrix-os.com",
    lease_id: "01HXYZ1234567890ABCDEFGHJK",
    acquired_at: 1712780000000,
    expires_at: 1712780060000,
  };

  it("accepts a valid lease", () => {
    expect(() => SnapshotLeaseContentSchema.parse(valid)).not.toThrow();
  });

  it("requires v", () => {
    expect(() => SnapshotLeaseContentSchema.parse({ ...valid, v: undefined })).toThrow();
  });

  it("requires writer", () => {
    expect(() => SnapshotLeaseContentSchema.parse({ ...valid, writer: undefined })).toThrow();
  });

  it("requires lease_id", () => {
    expect(() => SnapshotLeaseContentSchema.parse({ ...valid, lease_id: undefined })).toThrow();
  });

  it("requires acquired_at", () => {
    expect(() => SnapshotLeaseContentSchema.parse({ ...valid, acquired_at: undefined })).toThrow();
  });

  it("requires expires_at", () => {
    expect(() => SnapshotLeaseContentSchema.parse({ ...valid, expires_at: undefined })).toThrow();
  });
});

// ── GroupDataValueSchema ──────────────────────────────────────────────────────

describe("GroupDataValueSchema", () => {
  it("accepts null", () => {
    expect(() => GroupDataValueSchema.parse(null)).not.toThrow();
  });

  it("accepts a string", () => {
    expect(() => GroupDataValueSchema.parse("hello")).not.toThrow();
  });

  it("accepts a number", () => {
    expect(() => GroupDataValueSchema.parse(42)).not.toThrow();
  });

  it("accepts a boolean", () => {
    expect(() => GroupDataValueSchema.parse(true)).not.toThrow();
  });

  it("accepts a plain object", () => {
    expect(() => GroupDataValueSchema.parse({ key: "value" })).not.toThrow();
  });

  it("accepts an array", () => {
    expect(() => GroupDataValueSchema.parse([1, 2, 3])).not.toThrow();
  });

  it("accepts a nested object", () => {
    expect(() => GroupDataValueSchema.parse({ a: { b: { c: 1 } } })).not.toThrow();
  });

  it("rejects undefined", () => {
    expect(() => GroupDataValueSchema.parse(undefined)).toThrow();
  });

  it("rejects a function", () => {
    expect(() => GroupDataValueSchema.parse(() => {})).toThrow();
  });

  it("rejects a Date", () => {
    expect(() => GroupDataValueSchema.parse(new Date())).toThrow();
  });

  it("rejects a BigInt", () => {
    expect(() => GroupDataValueSchema.parse(BigInt(1))).toThrow();
  });

  it("rejects nesting deeper than 16 levels", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 17; i++) {
      deep = { value: deep };
    }
    expect(() => GroupDataValueSchema.parse(deep)).toThrow();
  });

  it("accepts nesting at exactly 16 levels", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 16; i++) {
      deep = { value: deep };
    }
    expect(() => GroupDataValueSchema.parse(deep)).not.toThrow();
  });

  it("rejects serialized value exceeding 256 KB", () => {
    const big = "x".repeat(256 * 1024 + 1);
    expect(() => GroupDataValueSchema.parse(big)).toThrow();
  });

  it("accepts serialized value at exactly 256 KB boundary", () => {
    // The string itself is 256*1024 chars (256KB as UTF-8 ASCII) — JSON.stringify adds quotes (2 bytes),
    // so the serialized form is 256*1024+2 bytes. This is just above the 256KB cap for JSON.stringify
    // output; the actual cap is applied to the JSON.stringify result.
    // Use a string that when JSON.stringify'd is exactly <=256*1024 bytes:
    const acceptable = "x".repeat(256 * 1024 - 2); // JSON.stringify adds 2 quotes → exactly 256KB
    expect(() => GroupDataValueSchema.parse(acceptable)).not.toThrow();
  });
});

// ── GroupDataRequestSchema ────────────────────────────────────────────────────

describe("GroupDataRequestSchema", () => {
  it("accepts a valid read request", () => {
    expect(() =>
      GroupDataRequestSchema.parse({ action: "read", app_slug: "my-app", key: "note1" })
    ).not.toThrow();
  });

  it("accepts a valid write request", () => {
    expect(() =>
      GroupDataRequestSchema.parse({ action: "write", app_slug: "my-app", key: "note1", value: "hello" })
    ).not.toThrow();
  });

  it("accepts a valid list request (no key required)", () => {
    expect(() =>
      GroupDataRequestSchema.parse({ action: "list", app_slug: "my-app" })
    ).not.toThrow();
  });

  it("rejects read without key", () => {
    expect(() =>
      GroupDataRequestSchema.parse({ action: "read", app_slug: "my-app" })
    ).toThrow();
  });

  it("rejects write without key", () => {
    expect(() =>
      GroupDataRequestSchema.parse({ action: "write", app_slug: "my-app", value: "v" })
    ).toThrow();
  });

  it("rejects write without value", () => {
    expect(() =>
      GroupDataRequestSchema.parse({ action: "write", app_slug: "my-app", key: "k" })
    ).toThrow();
  });

  it("rejects unknown action", () => {
    expect(() =>
      GroupDataRequestSchema.parse({ action: "delete", app_slug: "my-app", key: "k" })
    ).toThrow();
  });

  it("rejects invalid app_slug", () => {
    expect(() =>
      GroupDataRequestSchema.parse({ action: "list", app_slug: "UPPER-CASE" })
    ).toThrow();
  });
});

// ── Group-slug regex ──────────────────────────────────────────────────────────

describe("GROUP_SLUG_REGEX", () => {
  it("accepts valid slug", () => {
    expect(GROUP_SLUG_REGEX.test("schmidt-family")).toBe(true);
  });

  it("accepts slug starting with digit", () => {
    expect(GROUP_SLUG_REGEX.test("1-group")).toBe(true);
  });

  it("accepts slug with only letters", () => {
    expect(GROUP_SLUG_REGEX.test("abc")).toBe(true);
  });

  it("accepts maximum length slug (63 chars)", () => {
    expect(GROUP_SLUG_REGEX.test("a".repeat(63))).toBe(true);
  });

  it("rejects slug starting with hyphen", () => {
    expect(GROUP_SLUG_REGEX.test("-bad-start")).toBe(false);
  });

  it("rejects slug with uppercase", () => {
    expect(GROUP_SLUG_REGEX.test("BadSlug")).toBe(false);
  });

  it("rejects slug exceeding 63 chars", () => {
    expect(GROUP_SLUG_REGEX.test("a".repeat(64))).toBe(false);
  });

  it("rejects empty slug", () => {
    expect(GROUP_SLUG_REGEX.test("")).toBe(false);
  });

  it("rejects slug with spaces", () => {
    expect(GROUP_SLUG_REGEX.test("has space")).toBe(false);
  });

  it("rejects slug with underscore", () => {
    expect(GROUP_SLUG_REGEX.test("has_underscore")).toBe(false);
  });
});

// ── Member handle regex ───────────────────────────────────────────────────────

describe("MEMBER_HANDLE_REGEX", () => {
  it("accepts valid handle", () => {
    expect(MEMBER_HANDLE_REGEX.test("@hamed:matrix-os.com")).toBe(true);
  });

  it("accepts handle with underscores", () => {
    expect(MEMBER_HANDLE_REGEX.test("@user_name:server.org")).toBe(true);
  });

  it("accepts handle with digits in server", () => {
    expect(MEMBER_HANDLE_REGEX.test("@user:matrix1.example.com")).toBe(true);
  });

  it("rejects handle without @", () => {
    expect(MEMBER_HANDLE_REGEX.test("hamed:matrix-os.com")).toBe(false);
  });

  it("rejects handle without server part", () => {
    expect(MEMBER_HANDLE_REGEX.test("@hamed")).toBe(false);
  });

  it("rejects handle with uppercase user", () => {
    expect(MEMBER_HANDLE_REGEX.test("@Hamed:matrix-os.com")).toBe(false);
  });

  it("rejects local part longer than 32 chars", () => {
    expect(MEMBER_HANDLE_REGEX.test(`@${"a".repeat(33)}:matrix-os.com`)).toBe(false);
  });

  it("rejects server domain longer than 253 chars", () => {
    expect(MEMBER_HANDLE_REGEX.test(`@user:${"a".repeat(254)}`)).toBe(false);
  });

  it("rejects empty string", () => {
    expect(MEMBER_HANDLE_REGEX.test("")).toBe(false);
  });
});
