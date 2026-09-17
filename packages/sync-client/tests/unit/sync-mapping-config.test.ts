import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SyncConfig } from "../../src/lib/config.js";
import {
  deriveSyncScopeId,
  loadSyncMappingConfig,
  listSyncMappingConfigs,
  migrateLegacySyncConfig,
  migrateLegacySyncStateFile,
  saveSyncMappingConfig,
  syncMappingConfigPath,
  syncMappingStatePath,
} from "../../src/lib/sync-mapping-config.js";

describe("sync mapping config repository", () => {
  let configDir: string;

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), "sync-mapping-config-"));
  });

  afterEach(async () => {
    await rm(configDir, { recursive: true, force: true });
  });

  it("migrates a legacy mapping deterministically with deletion propagation paused", () => {
    const legacy: SyncConfig = {
      profile: "cloud",
      gatewayUrl: "https://app.matrix-os.com",
      syncPath: "/Users/alice/matrixos",
      gatewayFolder: "projects/alpha",
      peerId: "alice-mac-1234",
      exclude: ["dist/"],
      pauseSync: false,
    };

    const first = migrateLegacySyncConfig({
      legacy,
      profile: "cloud",
      ownerId: "user_alice",
      runtimeSlot: "primary",
      deviceId: "alice-mac-1234",
    });
    const second = migrateLegacySyncConfig({
      legacy,
      profile: "cloud",
      ownerId: "user_alice",
      runtimeSlot: "primary",
      deviceId: "alice-mac-1234",
    });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schemaVersion: 2,
      revision: 0,
      enabled: true,
      profile: "cloud",
      ownerId: "user_alice",
      runtimeSlot: "primary",
    });
    expect(first.mappings).toEqual([expect.objectContaining({
      label: "projects/alpha",
      localRoot: "/Users/alice/matrixos",
      remotePrefix: "projects/alpha",
      direction: "two_way",
      enabled: true,
      propagateDeletes: false,
      excludes: ["dist/"],
    })]);
  });

  it("preserves a legacy paused state during migration", () => {
    const migrated = migrateLegacySyncConfig({
      legacy: {
        gatewayUrl: "https://app.matrix-os.com",
        syncPath: "/home/alice/matrixos",
        gatewayFolder: "",
        peerId: "linux-device",
        pauseSync: true,
      },
      profile: "cloud",
      ownerId: "user_alice",
      runtimeSlot: "studio",
      deviceId: "linux-device",
    });

    expect(migrated.enabled).toBe(false);
    expect(migrated.mappings[0]).toMatchObject({
      label: "Matrix Home",
      enabled: false,
      propagateDeletes: false,
    });
  });

  it("persists revisions atomically and rejects a stale writer", async () => {
    const scope = { ownerId: "user_alice", runtimeSlot: "primary" };
    const initial = migrateLegacySyncConfig({
      legacy: {
        gatewayUrl: "https://app.matrix-os.com",
        syncPath: "/home/alice/matrixos",
        gatewayFolder: "",
        peerId: "linux-device",
        pauseSync: false,
      },
      profile: "cloud",
      ...scope,
      deviceId: "linux-device",
    });
    await saveSyncMappingConfig({ configDir, config: initial, expectedRevision: -1 });
    const updated = { ...initial, revision: 1, enabled: false };
    await saveSyncMappingConfig({ configDir, config: updated, expectedRevision: 0 });

    await expect(saveSyncMappingConfig({
      configDir,
      config: { ...updated, enabled: true },
      expectedRevision: 0,
    })).rejects.toMatchObject({ code: "sync_config_revision_conflict" });
    expect(await loadSyncMappingConfig({
      configDir,
      profile: "cloud",
      scope,
    })).toEqual(updated);
    expect(JSON.parse(await readFile(
      syncMappingConfigPath(configDir, "cloud", scope),
      "utf8",
    ))).toEqual(updated);
  });

  it("derives a stable opaque scope directory", () => {
    expect(deriveSyncScopeId({ ownerId: "user_alice", runtimeSlot: "primary" }))
      .toMatch(/^scope-[a-f0-9]{24}$/);
    expect(deriveSyncScopeId({ ownerId: "user_alice", runtimeSlot: "primary" }))
      .not.toBe(deriveSyncScopeId({ ownerId: "user_alice", runtimeSlot: "studio" }));
  });

  it("isolates durable state by scope and mapping id", () => {
    const mappingId = "11111111-1111-4111-8111-111111111111";
    const primary = syncMappingStatePath(configDir, {
      profile: "cloud",
      ownerId: "user_alice",
      runtimeSlot: "primary",
    }, mappingId);
    const studio = syncMappingStatePath(configDir, {
      profile: "cloud",
      ownerId: "user_alice",
      runtimeSlot: "studio",
    }, mappingId);

    expect(primary).not.toBe(studio);
    expect(primary).toContain(`/state/${mappingId}.json`);
    expect(primary).not.toContain("user_alice");
  });

  it("discovers bounded configs across profiles for overlap validation", async () => {
    const first = migrateLegacySyncConfig({
      legacy: {
        gatewayUrl: "https://gateway.example",
        syncPath: "/tmp/one",
        gatewayFolder: "one",
        peerId: "peer-one",
        pauseSync: false,
      },
      profile: "cloud",
      ownerId: "user_one",
      runtimeSlot: "primary",
      deviceId: "peer-one",
    });
    const second = migrateLegacySyncConfig({
      legacy: {
        gatewayUrl: "https://gateway.example",
        syncPath: "/tmp/two",
        gatewayFolder: "two",
        peerId: "peer-two",
        pauseSync: false,
      },
      profile: "local",
      ownerId: "user_two",
      runtimeSlot: "primary",
      deviceId: "peer-two",
    });
    await saveSyncMappingConfig({ configDir, config: first, expectedRevision: -1 });
    await saveSyncMappingConfig({ configDir, config: second, expectedRevision: -1 });

    await expect(listSyncMappingConfigs(configDir)).resolves.toEqual(
      expect.arrayContaining([first, second]),
    );
  });

  it("copies legacy common-base state exclusively without deleting the source", async () => {
    const source = join(configDir, "sync-state.json");
    const target = join(configDir, "profiles", "cloud", "sync", "scope-test", "state", "one.json");
    await writeFile(source, '{"manifestVersion":4}');

    await expect(migrateLegacySyncStateFile({
      legacyStateFile: source,
      targetStateFile: target,
    })).resolves.toBe("copied");
    await expect(migrateLegacySyncStateFile({
      legacyStateFile: source,
      targetStateFile: target,
    })).resolves.toBe("target_exists");
    await expect(readFile(source, "utf8")).resolves.toContain("manifestVersion");
    await expect(readFile(target, "utf8")).resolves.toBe('{"manifestVersion":4}');
  });
});
