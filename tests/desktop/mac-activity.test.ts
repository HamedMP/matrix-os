import { link, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type MenuItem = { label?: string; click?: () => void };
const native = vi.hoisted(() => ({
  tray: {
    destroy: vi.fn(),
    setContextMenu: vi.fn<(menu: MenuItem[]) => void>(),
    setTitle: vi.fn(),
    setToolTip: vi.fn(),
  },
  templateImage: { setTemplateImage: vi.fn() },
  owner: { show: vi.fn(), isDestroyed: vi.fn(() => false), destroy: vi.fn() },
  messageBox: vi.fn(),
}));
vi.mock("electron", () => ({
  Tray: class { constructor() { return native.tray; } },
  Menu: { buildFromTemplate: (items: MenuItem[]) => items },
  nativeImage: { createFromBuffer: () => native.templateImage },
  dialog: { showMessageBox: native.messageBox },
  BaseWindow: class { constructor() { return native.owner; } },
}));

import { createMacActivity } from "@desktop/main/mac-activity/activity";
import { createMacActivityHistory } from "@desktop/main/mac-activity/history";

const scope = "a".repeat(64);
const other = "b".repeat(64);
const worktree = "wt_0123456789ab";
const anotherWorktree = "wt_0123456789bc";
const directories: string[] = [];

async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "matrix-mac-activity-test-"));
  directories.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  vi.clearAllMocks();
});

describe("Mac activity", () => {
  it("shows the current phase and offers a native stop even without a renderer", async () => {
    const userData = await directory();
    const stop = vi.fn();
    const activity = createMacActivity({ userData, getScope: () => scope, stop });
    const watch = activity.begin("background-checks", worktree)!;
    watch.update("ready");
    const preview = activity.begin("preview", worktree)!;
    preview.update("awaiting-approval");
    expect(native.tray.setTitle).toHaveBeenLastCalledWith(expect.stringMatching(/approval/i));
    preview.update("running");
    expect(native.tray.setTitle).toHaveBeenLastCalledWith(expect.stringMatching(/running/i));
    native.tray.setContextMenu.mock.lastCall?.[0].find(item => item.label === "Stop Mac Activity")?.click?.();
    expect(stop).toHaveBeenCalledTimes(1);
    preview.finish("stopped");
    await vi.waitFor(() => expect(native.tray.setTitle).toHaveBeenLastCalledWith(expect.stringMatching(/ready/i)));
    watch.finish("stopped");
    expect(native.tray.destroy).toHaveBeenCalledTimes(1);
    await activity.close();
  });

  it("aborts an open history dialog and rejects stale stop actions after an account switch", async () => {
    const userData = await directory();
    let activeScope: string | null = scope;
    const getScope = () => activeScope;
    const stop = vi.fn();
    native.messageBox.mockResolvedValue({ response: 0 });
    native.messageBox.mockImplementationOnce((_owner, { signal }: { signal: AbortSignal }) => new Promise(resolve => {
      signal.addEventListener("abort", () => resolve({ response: 0 }), { once: true });
    }));
    const activity = createMacActivity({ userData, getScope, stop });
    const run = activity.begin("terminal", worktree)!;
    run.update("ready");
    run.update("running");
    const staleStop = native.tray.setContextMenu.mock.lastCall?.[0].find(item => item.label === "Stop Mac Activity")?.click;
    const reading = activity.showHistory();
    await vi.waitFor(() => expect(native.messageBox).toHaveBeenCalledTimes(1));
    expect(native.messageBox.mock.lastCall?.[0]).toBe(native.owner);
    const request = native.messageBox.mock.lastCall?.[1];
    expect(request?.detail).toContain(worktree);

    activeScope = other;
    activity.refresh();
    expect(request?.signal.aborted).toBe(true);
    await reading;
    expect(native.owner.destroy).toHaveBeenCalledTimes(1);
    staleStop?.();
    expect(stop).not.toHaveBeenCalled();
    run.finish("returned");
    await activity.showHistory();
    expect(native.messageBox.mock.lastCall?.[1].detail).not.toContain(worktree);
    activeScope = null;
    expect(activity.begin("preview", anotherWorktree)).toBeUndefined();
    await activity.close();
    const reopened = createMacActivityHistory(userData);
    const history = await reopened.read(scope);
    expect(history?.map(row => row.phase)).toEqual(["ready", "running", "revoked"]);
  });

  it("records activity even when the tray cannot be shown", async () => {
    const userData = await directory();
    const activity = createMacActivity({ userData, getScope: () => scope, stop: vi.fn() });
    native.tray.setTitle.mockImplementationOnce(() => { throw new Error("native tray failure"); });
    const run = activity.begin("terminal", worktree)!;
    expect(() => run.update("running")).not.toThrow();
    run.finish("returned");
    await activity.close();
    const history = await createMacActivityHistory(userData).read(scope);
    expect(history?.map(row => row.phase)).toEqual(["running", "returned"]);
  });

  // Spec 2716: the desktop link belongs to no worktree, and nothing else may omit one.
  it("records the desktop link without a worktree, and refuses a worktree-less entry of any other kind", async () => {
    const userData = await directory();
    const history = createMacActivityHistory(userData);
    await history.append(scope, { kind: "desktop-link", phase: "running" });
    await history.append(scope, { kind: "terminal", phase: "returned" });
    await history.append(scope, { kind: "desktop-link", phase: "stopped", worktreeId: worktree });
    await history.append(scope, { kind: "desktop-link", phase: "revoked" });
    const rows = await createMacActivityHistory(userData).read(scope);
    expect(rows?.map(({ kind, phase, worktreeId }) => ({ kind, phase, worktreeId }))).toEqual([
      { kind: "desktop-link", phase: "running", worktreeId: undefined },
      { kind: "desktop-link", phase: "revoked", worktreeId: undefined },
    ]);
  });

  // Fault detected (review): with four activities running, the desktop link got no entry,
  // so the desktop could stay linked with no indicator and no Stop.
  it("always has room for the desktop link's one entry", async () => {
    const userData = await directory();
    const activity = createMacActivity({ userData, getScope: () => scope, stop: vi.fn() });
    for (let index = 0; index < 4; index += 1) expect(activity.begin("terminal", worktree)).toBeDefined();
    expect(activity.begin("terminal", worktree)).toBeUndefined();
    expect(activity.begin("desktop-link")).toBeDefined();
    expect(activity.begin("desktop-link")).toBeUndefined();
  });

  it("rejects invalid scope and worktree IDs and persists no additional event data", async () => {
    const userData = await directory();
    const history = createMacActivityHistory(userData);
    const row = { kind: "terminal", phase: "returned", worktreeId: worktree } as const;
    await history.append(scope, { ...row, result: "private command output" } as typeof row);
    await history.append(scope, { ...row, worktreeId: "../../bad" });
    await history.append("../wrong", row);
    await history.append(scope, row);
    await history.append(other, { ...row, worktreeId: anotherWorktree });
    const fresh = createMacActivityHistory(userData);
    expect((await fresh.read(scope))?.map(item => item.worktreeId)).toEqual([worktree]);
    expect((await fresh.read(other))?.map(item => item.worktreeId)).toEqual([anotherWorktree]);
    expect(await fresh.read("../wrong")).toBeNull();
    const path = join(userData, "mac-activity", "events.json");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).not.toContain("private command output");
  });

  it.each([
    ["truncated JSON", '{"version":1,"rows":['],
    ["invalid rows", '{"version":1,"rows":[{"scope":"invalid"}]}'],
  ])("can save fresh activity after reopening history with %s", async (_damage, contents) => {
    const userData = await directory();
    const activityDir = join(userData, "mac-activity");
    await mkdir(activityDir, { mode: 0o700 });
    const path = join(activityDir, "events.json");
    await writeFile(path, contents, { mode: 0o600 });

    const history = createMacActivityHistory(userData);
    expect(await history.read(scope)).toBeNull();
    await Promise.all([
      history.append(scope, { kind: "terminal", phase: "returned", worktreeId: worktree }),
      history.append(other, { kind: "preview", phase: "stopped", worktreeId: anotherWorktree }),
    ]);

    const reopened = createMacActivityHistory(userData);
    expect(await reopened.read(scope)).toEqual([
      { kind: "terminal", phase: "returned", worktreeId: worktree, at: expect.any(Number) },
    ]);
    expect(await reopened.read(other)).toEqual([
      { kind: "preview", phase: "stopped", worktreeId: anotherWorktree, at: expect.any(Number) },
    ]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it.each([
    ["a future format", '{"version":2,"rows":[]}', 0o600],
    ["an oversized file", " ".repeat(64 * 1024 + 1), 0o600],
    ["a nonprivate file", "truncated", 0o644],
    ["a hard link", "truncated", 0o600],
  ])("does not replace %s during append", async (obstacle, contents, mode) => {
    const userData = await directory();
    const activityDir = join(userData, "mac-activity");
    await mkdir(activityDir, { mode: 0o700 });
    const path = join(activityDir, "events.json");
    await writeFile(path, contents, { mode });
    if (obstacle === "a hard link") await link(path, join(userData, "another-link"));
    const history = createMacActivityHistory(userData);

    await history.append(scope, { kind: "terminal", phase: "returned", worktreeId: worktree });

    expect(await history.read(scope)).toBeNull();
    expect(await readFile(path, "utf8")).toBe(contents);
  });

  it("caps retained rows, prunes expired events, and refuses symlinked history", async () => {
    const userData = await directory();
    let now = Date.now();
    let history = createMacActivityHistory(userData, () => now);
    for (let i = 0; i < 70; i++) {
      await history.append(scope, { kind: "preview", phase: "returned", worktreeId: worktree });
    }
    expect((await history.read(scope))?.length).toBe(64);
    now += 31 * 86_400_000;
    expect(await history.read(scope)).toEqual([]);

    const otherDir = await directory();
    const target = join(otherDir, "private.json");
    await writeFile(target, "unchanged");
    const poisoned = await directory();
    await mkdir(join(poisoned, "mac-activity"), { mode: 0o700 });
    await symlink(target, join(poisoned, "mac-activity", "events.json"));
    history = createMacActivityHistory(poisoned);
    expect(await history.read(scope)).toBeNull();
    await history.append(scope, { kind: "terminal", phase: "running", worktreeId: worktree });
    expect(await readFile(target, "utf8")).toBe("unchanged");
  });
});
