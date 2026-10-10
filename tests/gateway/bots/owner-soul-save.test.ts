import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { Hono } from "hono";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerFileRoutes } from "../../../packages/gateway/src/server/file-routes.js";
import { readOwnerSoul } from "../../../packages/gateway/src/bots/owner-personality.js";
import { writeOwnerSoulAtomic } from "../../../packages/gateway/src/bots/owner-personality-write.js";
import { withOwnerFileMutation } from "../../../packages/gateway/src/owner-file-mutations.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
let stageWrite: ((path: string, bytes: Buffer, write: (bytes: Buffer) => Promise<void>) => Promise<void>) | undefined;
let home: string;
let app: Hono;
beforeEach(async () => {
  stageWrite = undefined;
  vi.mocked(fs.open).mockReset().mockImplementation(async (path, flags, mode) => {
    const handle = await actual.open(path, flags, mode);
    const injected = stageWrite;
    if (flags === "wx" && injected) {
      const write = handle.writeFile.bind(handle);
      vi.spyOn(handle, "writeFile").mockImplementationOnce(async data => {
        await injected(String(path), Buffer.from(data as string), bytes => write(bytes));
      });
    }
    return handle;
  });
  home = await actual.realpath(await fs.mkdtemp(join(tmpdir(), "soul-atomic-save-")));
  await fs.mkdir(join(home, "system"));
  app = new Hono();
  registerFileRoutes(app, { homePath: home });
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(home, { recursive: true, force: true }); });

it("File API queues same-home SOUL saves while readers retain complete committed identity", async () => {
  const soul = join(home, "system", "soul.md");
  await actual.writeFile(soul, "Complete original identity", { mode: 0o640 });
  const before = await fs.stat(soul);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pause = new Promise<void>(resolve => { release = resolve; });
  const stages: string[] = [];
  stageWrite = async (_path, bytes, write) => {
    stages.push(bytes.toString("utf8"));
    if (stages.length === 1) {
      await write(bytes.subarray(0, 5)); entered(); await pause;
      await write(bytes.subarray(5));
    } else await write(bytes);
  };
  const first = app.request("/files/system/soul.md", { method: "PUT", body: "Complete first Rick profile" });
  await started;
  const second = app.request("/files/system/soul.md", { method: "PUT", body: "Complete second Rick profile" });
  try {
    await setImmediate(); await setImmediate();
    expect(stages).toEqual(["Complete first Rick profile"]);
    expect(await readOwnerSoul(home)).toBe("Complete original identity");
  } finally { release(); await Promise.allSettled([first, second]); }
  expect((await first).status).toBe(200); expect((await second).status).toBe(200);
  expect(stages).toEqual(["Complete first Rick profile", "Complete second Rick profile"]);
  expect(await readOwnerSoul(home)).toBe("Complete second Rick profile");
  const after = await fs.stat(soul);
  expect([after.mode & 0o777, after.uid, after.gid]).toEqual([0o640, before.uid, before.gid]);
  expect(await fs.readdir(join(home, "system"))).toEqual(["soul.md"]);
});

it("SOUL queue exhaustion returns coarse 503 without staging and drains for the next save", async () => {
  await actual.writeFile(join(home, "system", "soul.md"), "Complete old identity");
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pause = new Promise<void>(resolve => { release = resolve; });
  const holding = withOwnerFileMutation(home, async () => { entered(); await pause; });
  await started;
  const pending = Array.from({ length: 32 }, () => withOwnerFileMutation(home, async () => {}));
  try {
    const response = await app.request("/files/system/soul.md", { method: "PUT", body: "Uncommitted Rick" });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "File service unavailable" });
    expect(await readOwnerSoul(home)).toBe("Complete old identity");
    expect(await fs.readdir(join(home, "system"))).toEqual(["soul.md"]);
  } finally { release(); await Promise.all([holding, ...pending]); }
  expect((await app.request("/files/system/soul.md", { method: "PUT", body: "Complete Rick" })).status).toBe(200);
  expect(await readOwnerSoul(home)).toBe("Complete Rick");
});

it("failed and denied File API saves release the shared owner queue before a valid SOUL save", async () => {
  await actual.writeFile(join(home, "system", "soul.md"), "Complete old identity");
  stageWrite = async () => { throw Object.assign(new Error("private failure"), { code: "ENOSPC" }); };
  const failed = await app.request("/files/system/soul.md", { method: "PUT", body: "Failed Rick" });
  expect(failed.status).toBe(500);
  expect(await failed.json()).toEqual({ error: "Unable to save personality" });
  expect(await readOwnerSoul(home)).toBe("Complete old identity");
  stageWrite = undefined;
  const denied = await app.request("/files/data/app-gallery-staging/private.md", { method: "PUT", body: "denied" });
  expect(denied.status).toBe(403);
  expect(await fs.readdir(home)).toEqual(["system"]);
  expect((await app.request("/files/system/soul.md", { method: "PUT", body: "Complete Rick" })).status).toBe(200);
  expect(await readOwnerSoul(home)).toBe("Complete Rick");
  expect(await fs.readdir(join(home, "system"))).toEqual(["soul.md"]);
});

it.each(["empty", "prefix"])("a real SOUL read during a paused %s Settings write sees only the complete saved version", async stage => {
  const old = "Your name is Juniper. Keep the complete old preferences.";
  const next = "Your name is Rick. Keep the complete new preferences.\n".repeat(64).trim();
  const soul = join(home, "system", "soul.md");
  await actual.writeFile(soul, old);
  await fs.chmod(soul, 0o640);
  let writing!: () => void;
  const started = new Promise<void>(resolve => { writing = resolve; });
  let finish!: () => void;
  const pause = new Promise<void>(resolve => { finish = resolve; });
  stageWrite = async (_path, bytes, write) => {
    const half = stage === "empty" ? 0 : Math.floor(bytes.length / 2);
    await write(bytes.subarray(0, half));
    writing();
    await pause;
    await write(bytes.subarray(half));
  };
  const saving = app.request("/files/system/soul.md", { method: "PUT", body: next });
  try {
    await started;
    expect(await readOwnerSoul(home)).toBe(old);
  } finally { finish(); await saving; }
  expect((await saving).status).toBe(200);
  expect(await readOwnerSoul(home)).toBe(next);
  expect((await fs.stat(soul)).mode & 0o777).toBe(0o640);
  expect(await fs.readdir(join(home, "system"))).toEqual(["soul.md"]);
});


it("an interrupted staged write leaves the prior SOUL intact and cleans its temp", async () => {
  const soul = join(home, "system", "soul.md");
  await actual.writeFile(soul, "Complete old identity");
  const before = await fs.stat(soul);
  stageWrite = async (_path, _data, write) => {
    await write(Buffer.from("Incomplete new identity"));
    throw Object.assign(new Error("private I/O canary"), { code: "ENOSPC" });
  };
  const response = await app.request("/files/system/soul.md", { method: "PUT", body: "Complete Rick identity" });
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain("canary");
  expect(await readOwnerSoul(home)).toBe("Complete old identity");
  expect((await fs.stat(soul)).ino).toBe(before.ino);
  expect(await fs.readdir(join(home, "system"))).toEqual(["soul.md"]);
});

it.each(["file", "directory"])("rejects a %s symlink without modifying its target", async kind => {
  const outside = await fs.mkdtemp(join(tmpdir(), "soul-outside-"));
  try {
    await actual.writeFile(join(outside, "soul.md"), "Untouched outside identity");
    if (kind === "file") await fs.symlink(join(outside, "soul.md"), join(home, "system", "soul.md"));
    else {
      await fs.rmdir(join(home, "system"));
      await fs.symlink(outside, join(home, "system"));
    }
    const response = await app.request("/files/system/soul.md", { method: "PUT", body: "Rick" });
    expect(response.status).toBe(403);
    expect(await fs.readFile(join(outside, "soul.md"), "utf8")).toBe("Untouched outside identity");
    expect(await fs.readdir(outside)).toEqual(["soul.md"]);
  } finally { await fs.rm(outside, { recursive: true, force: true }); }
});

it("a replaced parent cannot redirect commit or cleanup to an outside file", async () => {
  const outside = await fs.mkdtemp(join(tmpdir(), "soul-parent-outside-"));
  const system = join(home, "system");
  await actual.writeFile(join(system, "soul.md"), "Old complete identity");
  let tempName = "";
  try {
    stageWrite = async (path, data, write) => {
      await write(data);
      tempName = String(path).split("/").at(-1)!;
      await fs.rename(system, join(home, "moved-system"));
      await fs.symlink(outside, system);
      await actual.writeFile(join(outside, tempName), "Unrelated outside file");
    };
    const response = await app.request("/files/system/soul.md", { method: "PUT", body: "Complete Rick identity" });
    expect(response.status).toBe(500);
    expect(await fs.readFile(join(outside, tempName), "utf8")).toBe("Unrelated outside file");
    expect(await fs.readFile(join(home, "moved-system", "soul.md"), "utf8")).toBe("Old complete identity");
    expect(await fs.readdir(outside)).toEqual([tempName]);
  } finally { await fs.rm(outside, { recursive: true, force: true }); }
});

it("creates a missing SOUL securely without changing other file save semantics", async () => {
  await fs.rmdir(join(home, "system"));
  const response = await app.request("/files/system/soul.md", { method: "PUT", body: "Rick" });
  expect(response.status).toBe(200);
  expect(await readOwnerSoul(home)).toBe("Rick");
  expect((await fs.stat(join(home, "system", "soul.md"))).mode & 0o777).toBe(0o600);
  const other = await app.request("/files/notes/test.md", { method: "PUT", body: "ordinary owner file" });
  expect(other.status).toBe(200);
  expect(await fs.readFile(join(home, "notes", "test.md"), "utf8")).toBe("ordinary owner file");
});

it("rejects a replaced staging symlink without changing outside metadata or publishing the link", async () => {
  const outside = await fs.mkdtemp(join(tmpdir(), "soul-stage-outside-"));
  const foreign = join(outside, "foreign.md");
  const soul = join(home, "system", "soul.md");
  try {
    await actual.writeFile(soul, "Complete old identity", { mode: 0o640 });
    await actual.writeFile(foreign, "Untouched foreign identity", { mode: 0o600 });
    stageWrite = async (path, data, write) => {
      await write(data);
      await fs.unlink(path);
      await fs.symlink(foreign, path);
    };
    const response = await app.request("/files/system/soul.md", { method: "PUT", body: "Complete Rick identity" });
    expect(response.status).toBe(500);
    expect((await fs.lstat(soul)).isSymbolicLink()).toBe(false);
    expect(await readOwnerSoul(home)).toBe("Complete old identity");
    expect(await fs.readFile(foreign, "utf8")).toBe("Untouched foreign identity");
    expect((await fs.stat(foreign)).mode & 0o777).toBe(0o600);
  } finally { await fs.rm(outside, { recursive: true, force: true }); }
});

it("repeated Settings saves each publish a complete UTF-8 SOUL and preserve metadata", async () => {
  const soul = join(home, "system", "soul.md");
  await actual.writeFile(soul, "Original complete identity", { mode: 0o640 });
  const owner = await fs.stat(soul);
  for (let index = 0; index < 24; index++) {
    const next = `Your name is Rick. 第 ${index} 次保存，保留原有性格。\n`.repeat(24).trim();
    const response = await app.request("/files/system/soul.md", { method: "PUT", body: next });
    expect(response.status).toBe(200);
    expect(await readOwnerSoul(home)).toBe(next);
    const saved = await fs.stat(soul);
    expect([saved.mode & 0o777, saved.uid, saved.gid]).toEqual([0o640, owner.uid, owner.gid]);
  }
  expect(await fs.readdir(join(home, "system"))).toEqual(["soul.md"]);
});

// These writer-level races cover non-File-API writers. File API saves are
// serialized by the owner/home middleware and are exercised below.
it("concurrent paused atomic writer saves expose only complete previously committed versions", async () => {
  const old = "Complete original identity";
  await actual.writeFile(join(home, "system", "soul.md"), old, { mode: 0o640 });
  const releases: Array<() => void> = [];
  let stageCount = 0;
  let allStarted!: () => void;
  const started = new Promise<void>(resolve => { allStarted = resolve; });
  stageWrite = async (_path, bytes, write) => {
    const half = Math.floor(bytes.length / 2);
    await write(bytes.subarray(0, half));
    const index = versions.indexOf(bytes.toString("utf8"));
    const pause = new Promise<void>(resolve => { releases[index] = resolve; });
    if (++stageCount === 8) allStarted();
    await pause;
    await write(bytes.subarray(half));
  };
  const versions = Array.from({ length: 8 }, (_, index) => `Rick complete concurrent profile ${index}. 中文性格。\n`.repeat(32).trim());
  const saving = versions.map(body => writeOwnerSoulAtomic(home, body));
  try {
    await started;
    expect(await readOwnerSoul(home)).toBe(old);
    // All partial writes exist simultaneously. Each completed commit must be
    // a whole submitted profile, never a combination of two staged writes.
    for (let index = 0; index < releases.length; index++) {
      releases[index]();
      await saving[index];
      expect([old, ...versions]).toContain(await readOwnerSoul(home));
    }
  } finally { releases.forEach(release => release()); await Promise.all(saving); }
  await Promise.all(saving);
  expect(versions).toContain(await readOwnerSoul(home));
  expect(await fs.readdir(join(home, "system"))).toEqual(["soul.md"]);
  stageWrite = undefined;
  const simultaneous = await Promise.all(versions.map(body => writeOwnerSoulAtomic(home, body)));
  expect(simultaneous).toHaveLength(8);
  expect(versions).toContain(await readOwnerSoul(home));
  expect(await fs.readdir(join(home, "system"))).toEqual(["soul.md"]);
});

it("an atomic writer commit between target inspection and open does not reject another valid save", async () => {
  const soul = join(home, "system", "soul.md");
  await actual.writeFile(soul, "Complete original identity", { mode: 0o640 });
  const delegate = vi.mocked(fs.open).getMockImplementation()!;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let resume!: () => void;
  const pause = new Promise<void>(resolve => { resume = resolve; });
  let first = true;
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    if (first && String(path).endsWith("/soul.md") && typeof flags === "number" && (flags & constants.O_WRONLY) !== 0) {
      first = false;
      entered();
      await pause;
    }
    return delegate(path, flags, mode);
  });
  const older = writeOwnerSoulAtomic(home, "Complete first Rick profile");
  try {
    await started;
    await writeOwnerSoulAtomic(home, "Complete second Rick profile");
    expect(await readOwnerSoul(home)).toBe("Complete second Rick profile");
  } finally { resume(); await older; }
  await older;
  expect(await readOwnerSoul(home)).toBe("Complete first Rick profile");
  expect((await fs.stat(soul)).mode & 0o777).toBe(0o640);
  expect(await fs.readdir(join(home, "system"))).toEqual(["soul.md"]);
});

it("bounds regular target replacement retries and retains a complete committed SOUL on exhaustion", async () => {
  const soul = join(home, "system", "soul.md");
  const replacement = join(home, "system", "replacement.md");
  await actual.writeFile(soul, "Complete original identity", { mode: 0o640 });
  const delegate = vi.mocked(fs.open).getMockImplementation()!;
  let replacements = 0;
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    if (String(path).endsWith("/soul.md") && typeof flags === "number" && (flags & constants.O_WRONLY) !== 0) {
      await actual.writeFile(replacement, `Complete concurrent version ${++replacements}`, { mode: 0o640 });
      await fs.rename(replacement, soul);
    }
    return delegate(path, flags, mode);
  });
  const response = await app.request("/files/system/soul.md", { method: "PUT", body: "Uncommitted Rick profile" });
  expect(response.status).toBe(500);
  expect(replacements).toBe(8);
  expect(await readOwnerSoul(home)).toBe("Complete concurrent version 8");
  expect(await fs.readdir(join(home, "system"))).toEqual(["soul.md"]);
});

it("does not retry a target symlink substitution during validation or modify the outside file", async () => {
  const outside = await fs.mkdtemp(join(tmpdir(), "soul-validation-outside-"));
  const foreign = join(outside, "soul.md");
  const soul = join(home, "system", "soul.md");
  try {
    await actual.writeFile(soul, "Complete original identity", { mode: 0o640 });
    await actual.writeFile(foreign, "Untouched outside identity", { mode: 0o600 });
    const delegate = vi.mocked(fs.open).getMockImplementation()!;
    let opens = 0;
    vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
      if (String(path).endsWith("/soul.md") && typeof flags === "number" && (flags & constants.O_WRONLY) !== 0) {
        opens++;
        await fs.rename(soul, join(home, "system", "prior.md"));
        await fs.symlink(foreign, soul);
      }
      return delegate(path, flags, mode);
    });
    const response = await app.request("/files/system/soul.md", { method: "PUT", body: "Rick" });
    expect(response.status).toBe(500);
    expect(opens).toBe(1);
    expect(await fs.readFile(foreign, "utf8")).toBe("Untouched outside identity");
    expect((await fs.stat(foreign)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(join(home, "system", "prior.md"), "utf8")).toBe("Complete original identity");
    expect((await fs.readdir(join(home, "system"))).sort()).toEqual(["prior.md", "soul.md"]);
  } finally { await fs.rm(outside, { recursive: true, force: true }); }
});
