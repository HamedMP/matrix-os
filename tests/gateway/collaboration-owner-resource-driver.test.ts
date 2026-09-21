import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOwnerResourceDriver } from "../../packages/gateway/src/collaboration/owner-resource-driver.js";

const OWNER = "user_owner";
const PROJECT = "project_alpha";

describe("owner resource driver boundary", () => {
  let base: string;
  let home: string;
  let project: string;
  let assets: string;
  let driver: ReturnType<typeof createOwnerResourceDriver>;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "matrix-collaboration-resources-"));
    home = join(base, "home");
    project = join(base, "project");
    assets = join(base, "assets");
    await Promise.all([mkdir(home), mkdir(project), mkdir(assets)]);
    driver = createOwnerResourceDriver({
      homePath: home,
      resolveProjectWorkingDirectory: async (ownerId, projectId) => ownerId === OWNER && projectId === PROJECT ? project : null,
      resolveAppAssetRoot: async (ownerId, projectId, appId) => ownerId === OWNER && projectId === PROJECT && appId === "board" ? assets : null,
    });
  });

  afterEach(async () => { driver.close(); await rm(base, { recursive: true, force: true }); });

  it("streams project bytes and atomically replaces a catalog path", async () => {
    await writeFile(join(project, "README.md"), "old");
    const namespace = { ownerId: OWNER, projectId: PROJECT, path: "README.md" };
    const before = await driver.fingerprint(namespace);
    const read = await driver.read({ ...namespace, expectedIncarnation: before });
    expect(read.size).toBe(3);
    expect(await new Response(read.stream).text()).toBe("old");
    await driver.write({ ...namespace, content: new TextEncoder().encode("new content") });
    expect(await readFile(join(project, "README.md"), "utf8")).toBe("new content");
    const incarnation = await driver.fingerprint(namespace);
    expect(incarnation).toMatch(/^[a-f0-9]{64}$/);
    expect(await driver.fingerprint(namespace)).toBe(incarnation);
  });

  it("checks the opened file identity before streaming a recreated path", async () => {
    const namespace = { ownerId: OWNER, projectId: PROJECT, path: "README.md" };
    await writeFile(join(project, "README.md"), "original");
    const original = await driver.fingerprint(namespace);
    await rm(join(project, "README.md"));
    await writeFile(join(project, "README.md"), "replacement private bytes");
    const replacement = await driver.fingerprint(namespace);
    expect(replacement).not.toBe(original);
    await expect(driver.read({ ...namespace, expectedIncarnation: original }))
      .rejects.toMatchObject({ code: "not_found" });
    const current = await driver.read({ ...namespace, expectedIncarnation: replacement });
    expect(await new Response(current.stream).text()).toBe("replacement private bytes");
  });

  it("refuses protected home paths and symlinks in every namespace", async () => {
    await mkdir(join(home, "system"));
    await writeFile(join(home, "system", "secret"), "private");
    await expect(driver.read({ ownerId: OWNER, projectId: null, path: "system/secret", expectedIncarnation: "none" }))
      .rejects.toMatchObject({ code: "forbidden" });
    await symlink(join(home, "system"), join(project, "linked"));
    await expect(driver.read({ ownerId: OWNER, projectId: PROJECT, path: "linked/secret", expectedIncarnation: "none" }))
      .rejects.toMatchObject({ code: "forbidden" });
    await expect(driver.write({ ownerId: OWNER, projectId: PROJECT, path: "linked/new", content: new Uint8Array([1]) }))
      .rejects.toMatchObject({ code: "forbidden" });
  });

  it("reads only resolved app assets and rejects hidden paths", async () => {
    await writeFile(join(assets, "main.js"), "export default 1");
    const asset = await driver.readAppAsset({ ownerId: OWNER, projectId: PROJECT, appId: "board", assetPath: "main.js" });
    expect(asset.contentType).toBe("text/javascript");
    expect(await new Response(asset.stream).text()).toBe("export default 1");
    await expect(driver.readAppAsset({ ownerId: OWNER, projectId: PROJECT, appId: "other", assetPath: "main.js" }))
      .rejects.toMatchObject({ code: "unavailable" });
    await expect(driver.readAppAsset({ ownerId: OWNER, projectId: PROJECT, appId: "board", assetPath: ".env" }))
      .rejects.toMatchObject({ code: "forbidden" });
  });
});
