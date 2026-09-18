import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile, unlink, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOutgoingRetry } from "../../src/daemon/outgoing-retry.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
describe("outgoing retry", () => {
  it("retains deletion intent if reconciliation recreates the local file", async () => {
    const root = await mkdtemp(join(tmpdir(), "matrix-retry-")); roots.push(root);
    const replay = vi.fn(async () => {});
    const retry = createOutgoingRetry({ syncRoot: root, replay, onError: vi.fn(), onOverflow: vi.fn() });
    retry.failed("deleted", "unlink");
    await writeFile(join(root, "deleted"), "remote update");
    expect(retry.isDeletion("deleted")).toBe(true);
    expect(retry.shouldPull("deleted", "remote-new", "remote-old")).toBe(false);
    expect(retry.shouldPull("deleted", "remote-old", "remote-old")).toBe(false);
    await retry.retry();
    expect(replay).toHaveBeenCalledWith({ type: "unlink", path: "deleted" });
    retry.failed("deleted", "change");
    expect(retry.isDeletion("deleted")).toBe(false);
    expect(retry.shouldPull("deleted", "remote-new", "remote-old")).toBe(true);
    expect(retry.shouldPull("deleted", "remote-old", "remote-old")).toBe(false);
  });
  it("rejects escaped and symlinked targets without replaying them", async () => {
    const root = await mkdtemp(join(tmpdir(), "matrix-retry-")); roots.push(root);
    await writeFile(join(root, "file"), "bytes");
    await symlink(join(root, "file"), join(root, "link"));
    const replay = vi.fn(async () => {});
    const onError = vi.fn();
    const retry = createOutgoingRetry({ syncRoot: root, replay, onError, onOverflow: vi.fn() });
    retry.failed("../outside"); retry.failed("link");
    await retry.retry();
    expect(replay).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(2);
  });
  it("bounds pending intent with oldest-entry eviction and an explicit overflow warning", () => {
    const onOverflow = vi.fn();
    const retry = createOutgoingRetry({ syncRoot: "/sync", replay: vi.fn(), onError: vi.fn(), onOverflow });
    for (let i = 0; i < 1001; i++) retry.failed(String(i));
    expect(retry.has("0")).toBe(false);
    expect(retry.has("1000")).toBe(true);
    expect(onOverflow).toHaveBeenCalledOnce();
  });
  it("replays existing and new local edits with current bytes, and retries deletions", async () => {
    const root = await mkdtemp(join(tmpdir(), "matrix-retry-")); roots.push(root);
    await writeFile(join(root, "existing"), "edited");
    await writeFile(join(root, "new"), "new");
    const replay = vi.fn(async () => {});
    const retry = createOutgoingRetry({ syncRoot: root, replay, onError: vi.fn(), onOverflow: vi.fn() });
    for (const path of ["existing", "new", "deleted"]) retry.failed(path);
    await retry.retry();
    expect(replay.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({ type: "change", path: "existing", size: 6 }),
      expect.objectContaining({ type: "change", path: "new", size: 3 }),
      { type: "unlink", path: "deleted" },
    ]);
    // Replay owns acknowledgement; swallowed upload errors must remain pending.
    expect(retry.has("existing")).toBe(true);
    retry.succeeded("existing");
    expect(retry.has("existing")).toBe(false);
    await unlink(join(root, "new"));
    await retry.retry();
    expect(replay).toHaveBeenLastCalledWith({ type: "unlink", path: "deleted" });
    expect(replay).toHaveBeenCalledWith({ type: "unlink", path: "new" });
    replay.mockClear();
    await retry.retry(() => false);
    expect(replay).not.toHaveBeenCalled();
    expect(retry.has("new")).toBe(true);
  });
});
