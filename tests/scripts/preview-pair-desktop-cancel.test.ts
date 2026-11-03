import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { startPreviewDesktop, stopOwnedPreviewChild } from "../../scripts/preview-pair/desktop-process.js";
import { issuePreviewPairLaunch } from "../../packages/platform/src/preview-pair/launch-proof.js";
import { previewPairManifestFixture, PAIR_NOW } from "../platform/preview-pair-test-support.js";

const observer = vi.hoisted(() => ({ spawned: undefined as ((child: ChildProcess) => void) | undefined }));
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    const child = actual.spawn(...args); observer.spawned?.(child); return child;
  } };
});

it("interrupting startup terminates its actual unacknowledged child promptly", async () => {
  const parent = await mkdtemp(join(tmpdir(), "eng418-cancel-")), abort = new AbortController();
  let child: ChildProcess | undefined, outcome: Promise<unknown> | undefined;
  try {
    const executable = join(parent, "waiting-app");
    await writeFile(executable, "#!/usr/bin/env node\nsetInterval(()=>{},1000);\n"); await chmod(executable, 0o755);
    const spawned = new Promise<ChildProcess>(resolve => { observer.spawned = resolve; });
    const proof = issuePreviewPairLaunch({ manifest: previewPairManifestFixture(), role: "owner", platform: "darwin",
      arch: "arm64", sourceOrigin: "https://app.matrix-os.com" }, "s".repeat(40), PAIR_NOW);
    // Existing callers may pass a signal before the startup helper handles it.
    const options = { executable, proof, userData: parent, timeoutMs: 30_000, signal: abort.signal };
    outcome = startPreviewDesktop(options).then(() => ({ ok: true }), error => ({ ok: false, error }));
    child = await spawned;
    const closed = once(child, "close", { signal: AbortSignal.timeout(3_000) });
    abort.abort();
    await closed;
    expect(child.signalCode).toBe("SIGTERM");
    expect(await outcome).toMatchObject({ ok: false, error: expect.any(Error) });
  } finally {
    observer.spawned = undefined;
    if (child) await stopOwnedPreviewChild(child);
    await outcome; await rm(parent, { recursive: true, force: true });
  }
});
