import { describe, expect, it } from "vitest";
import type { SyncMapping } from "@matrix-os/contracts";
import { planMappingOverlaps } from "../../src/lib/mapping-overlap.js";

function mapping(overrides: Partial<SyncMapping> = {}): SyncMapping {
  return {
    id: "1f17e3cb-e080-5a20-9ba3-d6ea45e7eac5",
    label: "Matrix Home",
    localRoot: "/Users/alice/MatrixOS",
    remotePrefix: "",
    direction: "two_way",
    enabled: true,
    propagateDeletes: false,
    excludes: [],
    ...overrides,
  };
}

describe("planMappingOverlaps", () => {
  const identityRealpath = async (path: string) => path;

  it("rejects case-normalized local overlap across profiles", async () => {
    const result = await planMappingOverlaps({
      candidate: {
        profile: "work",
        ownerId: "user_alice",
        runtimeSlot: "studio",
        mapping: mapping({
          id: "2f17e3cb-e080-5a20-9ba3-d6ea45e7eac5",
          localRoot: "/users/alice/matrixos/Projects",
          remotePrefix: "projects",
        }),
      },
      existing: [{
        profile: "cloud",
        ownerId: "user_alice",
        runtimeSlot: "primary",
        mapping: mapping(),
      }],
      realpath: identityRealpath,
      caseSensitive: false,
    });

    expect(result.ok).toBe(false);
    expect(result.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "local_overlap" }),
    ]));
  });

  it("rejects nested remote prefixes in one owner/runtime scope", async () => {
    const result = await planMappingOverlaps({
      candidate: {
        profile: "cloud",
        ownerId: "user_alice",
        runtimeSlot: "primary",
        mapping: mapping({
          id: "2f17e3cb-e080-5a20-9ba3-d6ea45e7eac5",
          localRoot: "/Users/alice/Work/project-a",
          remotePrefix: "projects/project-a",
        }),
      },
      existing: [{
        profile: "cloud",
        ownerId: "user_alice",
        runtimeSlot: "primary",
        mapping: mapping({ localRoot: "/Users/alice/MatrixOS" }),
      }],
      realpath: identityRealpath,
      caseSensitive: true,
    });

    expect(result.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "remote_overlap",
        requiredParentExclusion: "projects/project-a/",
      }),
    ]));
  });

  it("allows an explicit full-home child handoff only when both subtrees are excluded", async () => {
    const candidate = {
      profile: "cloud",
      ownerId: "user_alice",
      runtimeSlot: "primary",
      mapping: mapping({
        id: "2f17e3cb-e080-5a20-9ba3-d6ea45e7eac5",
        localRoot: "/Users/alice/MatrixOS/Work/project-a",
        remotePrefix: "projects/project-a",
      }),
    };
    const existing = [{
      profile: "cloud",
      ownerId: "user_alice",
      runtimeSlot: "primary",
      mapping: mapping({
        excludes: ["Work/project-a/", "projects/project-a/"],
      }),
    }];

    const result = await planMappingOverlaps({
      candidate,
      existing,
      realpath: identityRealpath,
      caseSensitive: true,
    });

    expect(result).toEqual({ ok: true, conflicts: [] });
  });

  it("ignores disabled mappings", async () => {
    const result = await planMappingOverlaps({
      candidate: {
        profile: "cloud",
        ownerId: "user_alice",
        runtimeSlot: "primary",
        mapping: mapping({ id: "2f17e3cb-e080-5a20-9ba3-d6ea45e7eac5" }),
      },
      existing: [{
        profile: "cloud",
        ownerId: "user_alice",
        runtimeSlot: "primary",
        mapping: mapping({ enabled: false }),
      }],
      realpath: identityRealpath,
      caseSensitive: true,
    });

    expect(result.ok).toBe(true);
  });
});
