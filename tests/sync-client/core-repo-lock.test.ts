/**
 * Matrix Core install lock under interleaved runs (spec 2691, layer 6). Every
 * filesystem call the lock makes passes through a hook, so another run can be
 * scheduled between any two of them.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hook = vi.hoisted(() => ({ after: null as null | (() => Promise<void>) }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const wrapped: Record<string, unknown> = { ...actual };
  for (const name of ["writeFile", "readFile", "stat", "lstat", "rename", "link", "rm", "unlink", "utimes", "readdir"] as const) {
    const original = actual[name] as (...args: unknown[]) => Promise<unknown>;
    wrapped[name] = async (...args: unknown[]) => {
      try { return await original(...args); }
      finally { if (hook.after) await hook.after(); }
    };
  }
  return { ...wrapped, default: wrapped };
});

const { CoreRepoLockedError, acquireCoreRepoLock } = await import("../../packages/sync-client/src/core-repo/lock.js");

type Lock = Awaited<ReturnType<typeof acquireCoreRepoLock>>;
let root: string;
let lock: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "core-lock-"));
  lock = join(root, ".lock");
});
afterEach(() => {
  hook.after = null;
  rmSync(root, { recursive: true, force: true });
});

/** Runs an acquire with hooks off; resolves to the handle or null when locked out. */
async function quietAcquire(): Promise<Lock | null> {
  const saved = hook.after;
  hook.after = null;
  try { return await acquireCoreRepoLock(lock); }
  catch (error: unknown) {
    if (error instanceof CoreRepoLockedError) return null;
    throw error;
  } finally { hook.after = saved; }
}

describe("Matrix Core install lock", () => {
  // Fault: two runs reclaim the same dead owner's lock; the second moves the first's fresh lock aside, a third creates
  // `.lock` in that window, and the restore deletes the first run's lock, so two installs run at once.
  it("never lets two runs hold the lock, whatever runs between the reclaimer's filesystem steps", async () => {
    const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
    const acquired: number[] = [];
    for (let step = 1; step <= 12; step += 1) {
      rmSync(lock, { force: true });
      writeFileSync(lock, JSON.stringify({ pid: dead, token: "dead-run" }));
      const holders: Lock[] = [];
      let ops = 0;
      // B is the reclaimer under test. Right after B reads the dead owner's lock, A reclaims it first;
      // after B's `step`-th later filesystem call, a third run C tries to acquire.
      hook.after = async () => {
        ops += 1;
        if (ops === 2) { const a = await quietAcquire(); if (a) holders.push(a); }
        if (ops === 2 + step) { const c = await quietAcquire(); if (c) holders.push(c); }
      };
      try { holders.push(await acquireCoreRepoLock(lock)); }
      catch (error: unknown) { if (!(error instanceof CoreRepoLockedError)) throw error; }
      hook.after = null;
      // Every acquisition is still unreleased here, so more than one is two concurrent installs.
      acquired.push(holders.length);
      for (const holder of holders) await holder.release();
      rmSync(lock, { force: true });
      expect(readdirSync(root).filter(entry => entry.includes(".reclaim-"))).toEqual([]);
    }
    expect(acquired).toEqual(Array(12).fill(1));
  });

  // Fault: a run whose lock was reclaimed keeps renaming files because the heartbeat never checks ownership.
  it("reports lost ownership after another run takes the lock, and leaves that run's lock in place", async () => {
    const held = await acquireCoreRepoLock(lock, { heartbeatMs: 10 });
    await held.assertHeld();
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "someone-else" }));
    await new Promise(resolve => setTimeout(resolve, 40));
    await expect(held.assertHeld()).rejects.toBeInstanceOf(CoreRepoLockedError);
    await held.release();
    expect(JSON.parse(readFileSync(lock, "utf8")).token).toBe("someone-else");
  });

  // Fault: a reclaimer that crashed mid-recovery leaves a marker that locks every later run out forever.
  it("recovers when an earlier reclaimer died while holding the recovery marker", async () => {
    const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
    const content = JSON.stringify({ pid: dead, token: "dead-run" });
    writeFileSync(lock, content);
    const { createHash } = await import("node:crypto");
    writeFileSync(`${lock}.reclaim-${createHash("sha256").update(content).digest("hex").slice(0, 32)}`, JSON.stringify({ pid: dead, token: "dead-reclaimer" }));
    const held = await acquireCoreRepoLock(lock);
    await held.assertHeld();
    await held.release();
    expect(readdirSync(root)).toEqual([]);
  });
});
