import { describe, expect, it, vi } from "vitest";
import type { SyncMappingConfig } from "@matrix-os/contracts";
import { createMappingControllerHandler } from "../../src/daemon/mapping-controller.js";

function config(): SyncMappingConfig {
  return {
    schemaVersion: 2,
    revision: 4,
    profile: "cloud",
    ownerId: "user_alice",
    runtimeSlot: "primary",
    deviceId: "device-1",
    enabled: true,
    mappings: [{
      id: "1f17e3cb-e080-5a20-9ba3-d6ea45e7eac5",
      label: "Matrix Home",
      localRoot: "/home/alice/matrixos",
      remotePrefix: "",
      direction: "two_way",
      enabled: true,
      propagateDeletes: false,
      excludes: [],
    }],
  };
}

describe("createMappingControllerHandler", () => {
  it("lists a token-free mapping snapshot", async () => {
    let current = config();
    const handler = createMappingControllerHandler({
      snapshot: () => current,
      commit: vi.fn(async (next) => { current = next; }),
    });

    await expect(handler("sync.mappings.list", {})).resolves.toEqual({ config: current });
  });

  it("adds, pauses, resumes and removes mappings with revision preconditions", async () => {
    let current = config();
    const commit = vi.fn(async (next: SyncMappingConfig) => { current = next; });
    const handler = createMappingControllerHandler({ snapshot: () => current, commit });
    const second = {
      id: "2f17e3cb-e080-5a20-9ba3-d6ea45e7eac5",
      label: "Project A",
      localRoot: "/home/alice/Work/project-a",
      remotePrefix: "projects/project-a",
      direction: "to_matrix" as const,
      enabled: true,
      propagateDeletes: false,
      excludes: ["dist/"],
    };

    await handler("sync.mappings.add", { expectedRevision: 4, mapping: second });
    expect(current.revision).toBe(5);
    expect(current.mappings).toHaveLength(2);
    await handler("sync.mappings.pause", { expectedRevision: 5, mappingId: second.id });
    expect(current.mappings[1]?.enabled).toBe(false);
    await handler("sync.mappings.resume", { expectedRevision: 6, mappingId: second.id });
    expect(current.mappings[1]?.enabled).toBe(true);
    await handler("sync.mappings.remove", { expectedRevision: 7, mappingId: second.id });
    expect(current.mappings).toHaveLength(1);
    expect(current.revision).toBe(8);
    expect(commit).toHaveBeenCalledTimes(4);
  });

  it("rejects stale revisions and missing mapping ids without committing", async () => {
    const current = config();
    const commit = vi.fn();
    const handler = createMappingControllerHandler({ snapshot: () => current, commit });

    await expect(handler("sync.mappings.pause", {
      expectedRevision: 3,
      mappingId: current.mappings[0]!.id,
    })).rejects.toMatchObject({ code: "sync_config_revision_conflict" });
    await expect(handler("sync.mappings.remove", {
      expectedRevision: 4,
      mappingId: "2f17e3cb-e080-5a20-9ba3-d6ea45e7eac5",
    })).rejects.toMatchObject({ code: "sync_mapping_not_found" });
    expect(commit).not.toHaveBeenCalled();
  });

  it("delegates rescan and conflict queries without mutating config", async () => {
    const current = config();
    const rescan = vi.fn().mockResolvedValue(undefined);
    const conflicts = vi.fn().mockReturnValue([{ mappingId: current.mappings[0]!.id }]);
    const handler = createMappingControllerHandler({
      snapshot: () => current,
      commit: vi.fn(),
      rescan,
      conflicts,
    });

    await expect(handler("sync.mappings.rescan", {
      mappingId: current.mappings[0]!.id,
    })).resolves.toEqual({ accepted: true });
    await expect(handler("sync.mappings.conflicts", {})).resolves.toEqual({
      conflicts: [{ mappingId: current.mappings[0]!.id }],
    });
    expect(rescan).toHaveBeenCalledWith(current.mappings[0]!.id);
  });
});
