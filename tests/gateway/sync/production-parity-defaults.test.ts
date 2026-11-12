import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { isHardExcluded } from "../../../packages/gateway/src/sync/home-mirror-ignore.js";
import { HomeMirrorWatcher } from "../../../packages/gateway/src/sync/home-mirror-watcher.js";

afterEach(() => { vi.unstubAllEnvs(); });

it("preserves main's sync inclusion policy with local parity disabled", () => {
  vi.stubEnv("MATRIX_LOCAL_PARITY_BUILD", undefined);
  expect(isHardExcluded(".cua-driver/packages/driver.md")).toBe(false);
  expect(isHardExcluded(".ssh/id_ed25519")).toBe(true);
  expect(isHardExcluded("node_modules/package/index.js")).toBe(true);
});

it("preserves main's watcher defaults with local parity disabled", async () => {
  vi.stubEnv("MATRIX_LOCAL_PARITY_BUILD", undefined);
  const root = await mkdtemp(join(tmpdir(), "matrix-parity-watcher-"));
  const home = join(root, "home"), target = join(root, "target");
  const onEvent = vi.fn(), onError = vi.fn();
  const watcher = new HomeMirrorWatcher({
    homeRoot: home, pruned: () => false, onEvent, onError, isCurrent: () => true,
  });
  try {
    await Promise.all([mkdir(home), mkdir(target)]);
    await symlink(target, join(home, "linked"), process.platform === "win32" ? "junction" : "dir");
    await watcher.replace(1);
    // Exercise the gateway's real dependency: a root-level chokidar mock can
    // resolve to a different workspace version and never intercept this watcher.
    await writeFile(join(target, "note.md"), "owner contents");
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledWith("push", join("linked", "note.md")), { timeout: 5000 });
    expect(onError).not.toHaveBeenCalled();
  } finally {
    try { await watcher.close(); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
});
