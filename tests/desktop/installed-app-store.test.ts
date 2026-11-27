import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInstalledAppStore,
  InstalledAppLimitError,
  MAX_INSTALLED_APPS,
} from "@desktop/main/installed-apps/record-store";

const ICON = "a".repeat(64);
const input = (overrides: Record<string, unknown> = {}) => ({
  appIdentity: "notes",
  slug: "notes",
  runtimeSlot: "primary",
  name: "Notes",
  iconSha256: ICON,
  bundlePath: null,
  cdHashes: [],
  ...overrides,
});

describe("installed app record store", () => {
  let dir: string;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "installed-apps-"));
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("persists a created record under a random UUID, never one derived from the folder name", async () => {
    const store = createInstalledAppStore({ dir, now: () => Date.parse("2026-11-27T10:00:00.000Z") });
    const record = await store.create(input({ slug: "notes", appIdentity: "notes" }));
    expect(record.installId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(record.installId).not.toContain("notes");
    expect(record.createdAt).toBe("2026-11-27T10:00:00.000Z");

    const reopened = createInstalledAppStore({ dir });
    expect(await reopened.get(record.installId)).toEqual(record);
    expect(await reopened.list()).toEqual([record]);
    const onDisk = JSON.parse(await readFile(join(dir, "installed-apps.json"), "utf8"));
    expect(onDisk).toEqual({ version: 1, records: [record] });
  });

  it("gives each install of the same app its own id", async () => {
    const store = createInstalledAppStore({ dir });
    const [first, second] = await Promise.all([store.create(input()), store.create(input())]);
    expect(first.installId).not.toBe(second.installId);
    expect((await store.list()).map((record) => record.installId).sort())
      .toEqual([first.installId, second.installId].sort());
  });

  it.each([
    ["a path-like slug", { slug: "../notes" }],
    ["an unsafe app identity", { appIdentity: "Notes/../../x" }],
    ["an empty name", { name: "  " }],
    ["a malformed icon hash", { iconSha256: "not-a-hash" }],
    ["a malformed code-directory hash", { cdHashes: ["zz"] }],
    ["an unknown field", { token: "secret" }],
  ])("rejects %s before writing anything", async (_label, overrides) => {
    const store = createInstalledAppStore({ dir });
    await expect(store.create(input(overrides) as never)).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
  });

  it("returns null for ids that are not UUIDs or not installed", async () => {
    const store = createInstalledAppStore({ dir });
    await store.create(input());
    expect(await store.get("notes")).toBeNull();
    expect(await store.get("../installed-apps")).toBeNull();
    expect(await store.get("6f1c2a4e-2b7d-4c1a-9f3e-1a2b3c4d5e6f")).toBeNull();
  });

  it("refuses to create past the install cap and keeps the existing records", async () => {
    const store = createInstalledAppStore({ dir });
    for (let index = 0; index < MAX_INSTALLED_APPS; index += 1) await store.create(input());
    await expect(store.create(input())).rejects.toBeInstanceOf(InstalledAppLimitError);
    expect(await store.list()).toHaveLength(MAX_INSTALLED_APPS);
  });

  it("removes one record and reports whether it existed", async () => {
    const store = createInstalledAppStore({ dir });
    const keep = await store.create(input({ name: "Keep" }));
    const drop = await store.create(input({ name: "Drop" }));
    expect(await store.remove(drop.installId)).toBe(true);
    expect(await store.remove(drop.installId)).toBe(false);
    expect(await store.remove("not-a-uuid")).toBe(false);
    expect(await store.list()).toEqual([keep]);
  });

  it("writes atomically: no temp files remain and a failed write keeps the previous file", async () => {
    const store = createInstalledAppStore({ dir });
    const first = await store.create(input());
    expect((await readdir(dir)).sort()).toEqual(["installed-apps.json"]);
    await chmod(dir, 0o500);
    try {
      await expect(store.create(input())).rejects.toThrow();
    } finally {
      await chmod(dir, 0o700);
    }
    expect(await createInstalledAppStore({ dir }).list()).toEqual([first]);
  });

  it("logs a corrupt file instead of silently treating it as empty, and quarantines it before the next write", async () => {
    await writeFile(join(dir, "installed-apps.json"), "{ not json");
    const store = createInstalledAppStore({ dir });
    expect(await store.list()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[installed-apps]"), expect.anything());
    // Removing from a corrupt store never rewrites it.
    expect(await store.remove("6f1c2a4e-2b7d-4c1a-9f3e-1a2b3c4d5e6f")).toBe(false);
    expect(await readFile(join(dir, "installed-apps.json"), "utf8")).toBe("{ not json");

    const record = await store.create(input());
    expect(await readFile(join(dir, "installed-apps.json.corrupt"), "utf8")).toBe("{ not json");
    expect(await store.list()).toEqual([record]);
  });

  it("treats a schema-invalid file as corrupt rather than dropping single records", async () => {
    const valid = await createInstalledAppStore({ dir }).create(input());
    await writeFile(join(dir, "installed-apps.json"), JSON.stringify({
      version: 1,
      records: [valid, { ...valid, installId: "not-a-uuid" }],
    }));
    expect(await createInstalledAppStore({ dir }).list()).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it("rejects a file with duplicate install ids", async () => {
    const valid = await createInstalledAppStore({ dir }).create(input());
    await writeFile(join(dir, "installed-apps.json"), JSON.stringify({ version: 1, records: [valid, valid] }));
    expect(await createInstalledAppStore({ dir }).get(valid.installId)).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("surfaces an unreadable file as an error, not as an empty store", async () => {
    await writeFile(join(dir, "installed-apps.json"), JSON.stringify({ version: 1, records: [] }));
    await chmod(join(dir, "installed-apps.json"), 0o000);
    try {
      if (process.getuid?.() === 0) return; // root ignores file modes
      await expect(createInstalledAppStore({ dir }).list()).rejects.toThrow("Install records are unavailable");
    } finally {
      await chmod(join(dir, "installed-apps.json"), 0o600);
    }
  });
});
