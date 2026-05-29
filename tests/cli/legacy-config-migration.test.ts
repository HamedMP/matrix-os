import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProfiles } from "../../packages/sync-client/src/lib/profiles.js";

const roots: string[] = [];

async function tempConfig() {
  const root = await mkdtemp(join(tmpdir(), "matrix-profiles-"));
  roots.push(root);
  return join(root, ".matrixos");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("legacy CLI profile migration", () => {
  it("migrates legacy auth/config into the cloud profile idempotently", async () => {
    const configDir = await tempConfig();
    await writeFile(join(configDir, "auth.json"), JSON.stringify({ accessToken: "tok" }), { flag: "wx" }).catch(async (err) => {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      await import("node:fs/promises").then(({ mkdir }) => mkdir(configDir, { recursive: true }));
      await writeFile(join(configDir, "auth.json"), JSON.stringify({ accessToken: "tok" }), { flag: "wx" });
    });
    await writeFile(join(configDir, "config.json"), JSON.stringify({ gatewayUrl: "http://local" }), { flag: "wx" });

    const first = await loadProfiles({ configDir });
    const second = await loadProfiles({ configDir });

    expect(first.active).toBe("cloud");
    expect(second.active).toBe("cloud");
    await expect(readFile(join(configDir, "profiles", "cloud", "auth.json"), "utf-8")).resolves.toContain("tok");
    await expect(readFile(join(configDir, "profiles", "cloud", "config.json"), "utf-8")).resolves.toContain("http://local");
  });

  it("ignores read-only legacy migration errors after profile files already exist", async () => {
    const configDir = await tempConfig();
    await mkdir(join(configDir, "profiles", "cloud"), { recursive: true });
    await writeFile(join(configDir, "profiles.json"), JSON.stringify({
      active: "cloud",
      profiles: {
        cloud: {
          platformUrl: "https://app.matrix-os.com",
          gatewayUrl: "https://app.matrix-os.com",
        },
      },
    }), { flag: "wx" });
    await writeFile(join(configDir, "auth.json"), JSON.stringify({ accessToken: "legacy" }), { flag: "wx" });
    await writeFile(join(configDir, "profiles", "cloud", "auth.json"), JSON.stringify({ accessToken: "profile" }), { flag: "wx" });
    await chmod(configDir, 0o500);

    try {
      await expect(loadProfiles({ configDir })).resolves.toMatchObject({ active: "cloud" });
      await expect(readFile(join(configDir, "profiles", "cloud", "auth.json"), "utf-8")).resolves.toContain("profile");
    } finally {
      await chmod(configDir, 0o700);
    }
  });
});
