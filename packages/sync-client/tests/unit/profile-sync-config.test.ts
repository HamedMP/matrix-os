import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadProfileSyncConfig,
  saveProfileSyncConfig,
  syncConfigBindingPath,
} from "../../src/lib/profile-sync-config.js";
import { profileConfigPath, saveProfiles } from "../../src/lib/profiles.js";
import type { SyncConfig } from "../../src/lib/config.js";

const roots: string[] = [];
const faults = vi.hoisted(() => ({ partialWrite: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
    if (faults.partialWrite && String(args[0]).includes("profiles/cloud/")) {
      faults.partialWrite = false;
      await fs.writeFile(args[0], "{", args[2]);
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    }
    return fs.writeFile(...args);
  } };
});

async function tempConfigDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "matrix-profile-sync-config-"));
  roots.push(root);
  return join(root, ".matrixos");
}

function config(overrides: Partial<SyncConfig> = {}): SyncConfig {
  return {
    profile: "cloud",
    platformUrl: "https://app.matrix-os.com",
    gatewayUrl: "https://app.matrix-os.com",
    syncPath: "/tmp/matrix-home",
    gatewayFolder: "",
    peerId: "peer-one",
    pauseSync: false,
    ...overrides,
  };
}

async function seedProfiles(configDir: string, active = "cloud"): Promise<void> {
  await saveProfiles({
    active,
    profiles: {
      cloud: {
        platformUrl: "https://app.matrix-os.com",
        gatewayUrl: "https://app.matrix-os.com",
      },
      local: {
        platformUrl: "http://localhost:9000",
        gatewayUrl: "http://localhost:4000",
      },
    },
  }, configDir);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("profile-aware sync config", () => {
  it("does not rebind the daemon when saving login configuration", async () => {
    const configDir = await tempConfigDir();
    await seedProfiles(configDir);
    await saveProfileSyncConfig(config(), { configDir });
    await saveProfileSyncConfig(config({ profile: "local" }), { configDir, bindDaemon: false });
    expect((await loadProfileSyncConfig({ configDir }))?.profileName).toBe("cloud");
  });

  it("ignores malformed legacy rollback state when a bound profile is valid", async () => {
    const configDir = await tempConfigDir();
    await seedProfiles(configDir);
    await saveProfileSyncConfig(config(), { configDir });
    await writeFile(join(configDir, "config.json"), "{");
    expect((await loadProfileSyncConfig({ configDir }))?.config.peerId).toBe("peer-one");
  });
  it("recovers after an abandoned migration lock", async () => {
    const configDir = await tempConfigDir();
    await seedProfiles(configDir);
    await writeFile(join(configDir, "config.json"), JSON.stringify(config()));
    await writeFile(join(configDir, ".sync-config-migration.lock"), "");
    await expect(loadProfileSyncConfig({ configDir })).resolves.toMatchObject({ profileName: "cloud" });
  });

  it("never publishes a partial config and retries from the intact legacy source", async () => {
    const configDir = await tempConfigDir();
    await seedProfiles(configDir);
    await writeFile(join(configDir, "config.json"), JSON.stringify(config()));
    faults.partialWrite = true;
    await expect(loadProfileSyncConfig({ configDir })).rejects.toMatchObject({ code: "ENOSPC" });
    await expect(readFile(profileConfigPath("cloud", configDir))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(loadProfileSyncConfig({ configDir })).resolves.toMatchObject({ profileName: "cloud" });
  });

  it("publishes one complete config under concurrent migration attempts", async () => {
    const configDir = await tempConfigDir();
    await seedProfiles(configDir);
    await writeFile(join(configDir, "config.json"), JSON.stringify(config()));
    const results = await Promise.all(Array.from({ length: 4 }, () => loadProfileSyncConfig({ configDir })));
    expect(results.every((result) => result?.config.peerId === "peer-one")).toBe(true);
  });
  it("copies a legacy-only config into its profile and keeps a rollback source", async () => {
    const configDir = await tempConfigDir();
    await seedProfiles(configDir);
    await writeFile(join(configDir, "config.json"), JSON.stringify(config()), {
      mode: 0o640,
      flag: "wx",
    });

    const resolved = await loadProfileSyncConfig({ configDir });

    expect(resolved).toMatchObject({ profileName: "cloud", source: "legacy_migrated" });
    await expect(readFile(profileConfigPath("cloud", configDir), "utf-8")).resolves.toContain(
      '"peerId": "peer-one"',
    );
    await expect(readFile(join(configDir, "config.json"), "utf-8")).resolves.toContain(
      '"peerId":"peer-one"',
    );
    await expect(readFile(syncConfigBindingPath(configDir), "utf-8")).resolves.toContain(
      '"profile": "cloud"',
    );
  });

  it("loads a profile-only config without consulting the legacy path", async () => {
    const configDir = await tempConfigDir();
    await seedProfiles(configDir);
    await mkdir(join(configDir, "profiles", "cloud"), { recursive: true });
    await writeFile(profileConfigPath("cloud", configDir), JSON.stringify(config()), { flag: "wx" });

    await expect(loadProfileSyncConfig({ configDir })).resolves.toMatchObject({
      profileName: "cloud",
      source: "profile",
      config: { peerId: "peer-one" },
    });
  });

  it("fails closed when unbound legacy and profile configs disagree", async () => {
    const configDir = await tempConfigDir();
    await seedProfiles(configDir);
    await mkdir(join(configDir, "profiles", "cloud"), { recursive: true });
    await writeFile(join(configDir, "config.json"), JSON.stringify(config({ syncPath: "/tmp/legacy" })), {
      flag: "wx",
    });
    await writeFile(
      profileConfigPath("cloud", configDir),
      JSON.stringify(config({ syncPath: "/tmp/profile" })),
      { flag: "wx" },
    );

    await expect(loadProfileSyncConfig({ configDir })).rejects.toMatchObject({
      code: "sync_config_ambiguous",
    });
    await expect(readFile(join(configDir, "config.json"), "utf-8")).resolves.toContain("/tmp/legacy");
    await expect(readFile(profileConfigPath("cloud", configDir), "utf-8")).resolves.toContain("/tmp/profile");
  });

  it("keeps daemon restart resolution pinned after the active CLI profile changes", async () => {
    const configDir = await tempConfigDir();
    await seedProfiles(configDir);
    await saveProfileSyncConfig(config(), { configDir });
    await seedProfiles(configDir, "local");

    const firstRestart = await loadProfileSyncConfig({ configDir });
    const secondRestart = await loadProfileSyncConfig({ configDir });

    expect(firstRestart?.profileName).toBe("cloud");
    expect(secondRestart?.profileName).toBe("cloud");
    expect(secondRestart?.config.peerId).toBe("peer-one");
  });

  it("does not destroy the legacy config when profile migration cannot write", async () => {
    const configDir = await tempConfigDir();
    await seedProfiles(configDir);
    await writeFile(join(configDir, "config.json"), JSON.stringify(config()), { flag: "wx" });
    await chmod(configDir, 0o500);

    try {
      await expect(loadProfileSyncConfig({ configDir })).rejects.toBeDefined();
      await expect(readFile(join(configDir, "config.json"), "utf-8")).resolves.toContain("peer-one");
    } finally {
      await chmod(configDir, 0o700);
    }
  });
});
