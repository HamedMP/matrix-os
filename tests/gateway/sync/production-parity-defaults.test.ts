import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { watch } from "chokidar";
import { isHardExcluded } from "../../../packages/gateway/src/sync/home-mirror-ignore.js";
import { HomeMirrorWatcher } from "../../../packages/gateway/src/sync/home-mirror-watcher.js";

vi.mock("chokidar", () => ({ watch: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it("preserves main's sync inclusion policy with local parity disabled", () => {
  vi.stubEnv("MATRIX_LOCAL_PARITY_BUILD", undefined);
  expect(isHardExcluded(".cua-driver/packages/driver.md")).toBe(false);
  expect(isHardExcluded(".ssh/id_ed25519")).toBe(true);
  expect(isHardExcluded("node_modules/package/index.js")).toBe(true);
});

it("preserves main's watcher defaults with local parity disabled", async () => {
  vi.stubEnv("MATRIX_LOCAL_PARITY_BUILD", undefined);
  const target = Object.assign(new EventEmitter(), { close: vi.fn(async () => {}) });
  vi.mocked(watch).mockReturnValue(target as unknown as ReturnType<typeof watch>);
  const watcher = new HomeMirrorWatcher({
    homeRoot: "/owner/home", pruned: () => false, onEvent: vi.fn(),
    onError: vi.fn(), isCurrent: () => true,
  });
  const ready = watcher.replace(1);
  target.emit("ready");
  await ready;
  try {
    const options = vi.mocked(watch).mock.calls[0][1];
    // Chokidar follows directory links by default on main. Local tooling
    // must not silently change that owner-home policy in deployed bundles.
    expect(options?.followSymlinks ?? true).toBe(true);
  } finally { await watcher.close(); }
});
