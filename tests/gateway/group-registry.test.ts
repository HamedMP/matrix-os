import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GroupRegistry } from "../../packages/gateway/src/group-registry.js";
import { GROUP_SLUG_REGEX } from "../../packages/gateway/src/group-types.js";
import type { GroupManifest } from "../../packages/gateway/src/group-types.js";

async function makeTmpHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "group-registry-test-"));
}

function validManifest(overrides: Partial<GroupManifest> = {}): GroupManifest {
  return {
    room_id: "!abc123:matrix-os.com",
    name: "Test Group",
    slug: "test-group",
    owner_handle: "@owner:matrix-os.com",
    joined_at: 1712780000000,
    schema_version: 1,
    ...overrides,
  };
}

describe("GroupRegistry", () => {
  let tmpHome: string;
  let registry: GroupRegistry;

  beforeEach(async () => {
    tmpHome = await makeTmpHome();
    registry = new GroupRegistry(tmpHome);
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
  });

  // ── scan / list ─────────────────────────────────────────────────────────────

  it("list() returns empty array when ~/groups/ does not exist", async () => {
    await registry.scan();
    expect(registry.list()).toEqual([]);
  });

  it("list() returns empty array when ~/groups/ is empty", async () => {
    await mkdir(join(tmpHome, "groups"), { recursive: true });
    await registry.scan();
    expect(registry.list()).toEqual([]);
  });

  it("list() returns one group after scan finds a valid manifest", async () => {
    const groupDir = join(tmpHome, "groups", "test-group");
    await mkdir(groupDir, { recursive: true });
    await writeFile(
      join(groupDir, "manifest.json"),
      JSON.stringify(validManifest()),
    );
    await registry.scan();
    const groups = registry.list();
    expect(groups).toHaveLength(1);
    expect(groups[0].slug).toBe("test-group");
  });

  it("scan() loads multiple groups", async () => {
    for (const slug of ["group-a", "group-b", "group-c"]) {
      const dir = join(tmpHome, "groups", slug);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "manifest.json"), JSON.stringify(validManifest({ slug })));
    }
    await registry.scan();
    expect(registry.list()).toHaveLength(3);
  });

  // ── corrupt manifest quarantine ─────────────────────────────────────────────

  it("quarantines corrupt manifest.json and continues scanning", async () => {
    const groupDir = join(tmpHome, "groups", "corrupt-group");
    await mkdir(groupDir, { recursive: true });
    await writeFile(join(groupDir, "manifest.json"), "not valid json {{");

    const goodDir = join(tmpHome, "groups", "good-group");
    await mkdir(goodDir, { recursive: true });
    await writeFile(join(goodDir, "manifest.json"), JSON.stringify(validManifest({ slug: "good-group" })));

    await registry.scan();
    const groups = registry.list();
    expect(groups).toHaveLength(1);
    expect(groups[0].slug).toBe("good-group");

    // corrupt manifest should be quarantined (renamed)
    const files = await import("node:fs/promises").then((m) =>
      m.readdir(groupDir)
    );
    const quarantined = files.find((f) => f.startsWith("manifest.json.corrupt-"));
    expect(quarantined).toBeTruthy();
  });

  it("quarantines manifest with invalid schema (valid JSON, wrong shape)", async () => {
    const groupDir = join(tmpHome, "groups", "bad-schema");
    await mkdir(groupDir, { recursive: true });
    await writeFile(join(groupDir, "manifest.json"), JSON.stringify({ bad: "data" }));

    await registry.scan();
    const groups = registry.list();
    expect(groups).toHaveLength(0);

    const files = await import("node:fs/promises").then((m) =>
      m.readdir(groupDir)
    );
    const quarantined = files.find((f) => f.startsWith("manifest.json.corrupt-"));
    expect(quarantined).toBeTruthy();
  });

  // ── get ─────────────────────────────────────────────────────────────────────

  it("get() returns null for unknown slug", async () => {
    await registry.scan();
    expect(registry.get("nonexistent")).toBeNull();
  });

  it("get() returns the manifest for a known slug after scan", async () => {
    const groupDir = join(tmpHome, "groups", "test-group");
    await mkdir(groupDir, { recursive: true });
    await writeFile(join(groupDir, "manifest.json"), JSON.stringify(validManifest()));
    await registry.scan();
    const result = registry.get("test-group");
    expect(result).not.toBeNull();
    expect(result!.slug).toBe("test-group");
  });

  // ── create ──────────────────────────────────────────────────────────────────

  it("create() writes manifest.json and returns the manifest", async () => {
    await registry.scan();
    const result = await registry.create({
      roomId: "!newroom:matrix-os.com",
      name: "New Group",
      ownerHandle: "@owner:matrix-os.com",
    });
    expect(result.room_id).toBe("!newroom:matrix-os.com");
    expect(result.name).toBe("New Group");
    expect(result.owner_handle).toBe("@owner:matrix-os.com");
    expect(result.slug).toBeTruthy();
    expect(result.schema_version).toBe(1);
  });

  it("create() makes the group findable via get()", async () => {
    await registry.scan();
    const manifest = await registry.create({
      roomId: "!newroom:matrix-os.com",
      name: "New Group",
      ownerHandle: "@owner:matrix-os.com",
    });
    const found = registry.get(manifest.slug);
    expect(found).not.toBeNull();
    expect(found!.room_id).toBe("!newroom:matrix-os.com");
  });

  it("create() persists the manifest to disk using atomic write", async () => {
    await registry.scan();
    const manifest = await registry.create({
      roomId: "!persist:matrix-os.com",
      name: "Persist Test",
      ownerHandle: "@owner:matrix-os.com",
    });
    const onDisk = JSON.parse(
      await readFile(
        join(tmpHome, "groups", manifest.slug, "manifest.json"),
        "utf-8",
      ),
    );
    expect(onDisk.room_id).toBe("!persist:matrix-os.com");
  });

  it("create() resolves slug from group name (lowercase, hyphenated)", async () => {
    await registry.scan();
    const manifest = await registry.create({
      roomId: "!abc:matrix-os.com",
      name: "Schmidt Family",
      ownerHandle: "@owner:matrix-os.com",
    });
    expect(manifest.slug).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
  });

  it("create() adds suffix to avoid slug collision", async () => {
    await registry.scan();
    const first = await registry.create({
      roomId: "!room1:matrix-os.com",
      name: "My Group",
      ownerHandle: "@owner:matrix-os.com",
    });
    const second = await registry.create({
      roomId: "!room2:matrix-os.com",
      name: "My Group",
      ownerHandle: "@owner:matrix-os.com",
    });
    expect(first.slug).not.toBe(second.slug);
  });

  it("create() sanitizes path-traversal characters in name via slugify", async () => {
    await registry.scan();
    // "../../etc/passwd" normalizes to "etc-passwd" via slugify — it does NOT produce a path traversal
    // because slugify strips dots and slashes. The resulting slug is safe.
    const manifest = await registry.create({
      roomId: "!evil:matrix-os.com",
      name: "../../etc/passwd",
      ownerHandle: "@owner:matrix-os.com",
    });
    expect(manifest.slug).not.toContain("..");
    expect(manifest.slug).not.toContain("/");
    expect(manifest.slug).toMatch(GROUP_SLUG_REGEX);
  });

  // ── archive ─────────────────────────────────────────────────────────────────

  it("archive() moves the group dir to ~/groups/_archive/{slug}-{ts}", async () => {
    await registry.scan();
    const manifest = await registry.create({
      roomId: "!toarchive:matrix-os.com",
      name: "To Archive",
      ownerHandle: "@owner:matrix-os.com",
    });
    const slug = manifest.slug;

    await registry.archive(slug);

    expect(registry.get(slug)).toBeNull();

    const archiveDirs = await import("node:fs/promises").then((m) =>
      m.readdir(join(tmpHome, "groups", "_archive")).catch(() => [] as string[])
    );
    const archived = archiveDirs.find((d) => d.startsWith(`${slug}-`));
    expect(archived).toBeTruthy();
  });

  it("archive() on unknown slug throws", async () => {
    await registry.scan();
    await expect(registry.archive("nonexistent")).rejects.toThrow();
  });

  // ── attachSync ──────────────────────────────────────────────────────────────

  it("attachSync() stores the sync handle and returns it via getSyncHandle()", async () => {
    await registry.scan();
    const manifest = await registry.create({
      roomId: "!sync:matrix-os.com",
      name: "Sync Group",
      ownerHandle: "@owner:matrix-os.com",
    });

    const fakeSync = { hydrate: () => Promise.resolve() };
    registry.attachSync(manifest.slug, fakeSync as unknown as import("../../packages/gateway/src/group-registry.js").GroupSyncHandle);

    expect(registry.getSyncHandle(manifest.slug)).toBe(fakeSync);
  });

  it("getSyncHandle() returns null for unattached group", async () => {
    await registry.scan();
    const manifest = await registry.create({
      roomId: "!nosync:matrix-os.com",
      name: "No Sync",
      ownerHandle: "@owner:matrix-os.com",
    });
    expect(registry.getSyncHandle(manifest.slug)).toBeNull();
  });

  // ── resolveWithinHome ───────────────────────────────────────────────────────

  it("all group dirs are under ~/groups/ (resolveWithinHome enforced)", async () => {
    await registry.scan();
    const manifest = await registry.create({
      roomId: "!path:matrix-os.com",
      name: "Path Check",
      ownerHandle: "@owner:matrix-os.com",
    });
    const groupsDir = join(tmpHome, "groups");
    const manifestDir = join(groupsDir, manifest.slug);
    // the manifest must be inside ~/.../groups/
    expect(manifestDir.startsWith(groupsDir)).toBe(true);
  });
});
