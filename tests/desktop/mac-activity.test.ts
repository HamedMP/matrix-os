import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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
