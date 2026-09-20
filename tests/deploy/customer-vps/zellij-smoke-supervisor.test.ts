import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const SUPERVISOR_START_TIMEOUT_MS = 10_000;
const SUPERVISOR_CLEANUP_GRACE_MS = 1_000;

function cancellableDelay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

async function waitForStartedMarker(path: string, closed: Promise<number | null>, readMarker = readFile) {
  const controller = new AbortController();
  const marker = (async () => {
    const deadline = Date.now() + SUPERVISOR_START_TIMEOUT_MS;
    while (!controller.signal.aborted && Date.now() < deadline) {
      try {
        return JSON.parse(await readMarker(path, "utf8")) as { fixture: string };
      } catch (error) {
        if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await cancellableDelay(50, controller.signal);
    }
    if (controller.signal.aborted) throw new Error("Zellij smoke startup poll cancelled");
    throw new Error("Zellij smoke supervisor did not start");
  })();
  try {
    return await Promise.race([
      marker,
      closed.then((code) => { throw new Error(`Zellij smoke supervisor exited before startup (${code})`); }),
    ]);
  } finally {
    controller.abort();
  }
}

async function waitForClose(closed: Promise<number | null>, timeout: number) {
  return Promise.race([
    closed.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), timeout)),
  ]);
}

describe("Zellij smoke supervisor", () => {
  it("keeps supervisor startup bounded with saturated-CI headroom", () => {
    expect(SUPERVISOR_START_TIMEOUT_MS).toBeGreaterThanOrEqual(8_000);
    expect(SUPERVISOR_START_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });

  it("cancels the marker poll when the supervisor exits before startup", async () => {
    vi.useFakeTimers();
    try {
      let close!: (code: number | null) => void;
      const closed = new Promise<number | null>((resolve) => { close = resolve; });
      const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
      const waiting = waitForStartedMarker("/missing", closed, async () => { throw missing; });
      await Promise.resolve();
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(1);
      close(1);
      await expect(waiting).rejects
        .toThrow("exited before startup");
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([false, true])("cleans an interrupted worker and preserves its error (cleanup fails: %s)", async (cleanupFails) => {
    const root = await mkdtemp(join(tmpdir(), "mzc-supervisor-"));
    const marker = join(root, "started.json");
    const cleaned = join(root, "cleaned");
    const binary = join(root, "fake-zellij");
    let child: ReturnType<typeof spawn> | undefined;
    let closed: Promise<number | null> | undefined;
    try {
      await writeFile(binary, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] === 'kill-session') {
  const original = JSON.parse(fs.readFileSync(${JSON.stringify(marker)}, 'utf8'));
  try { process.kill(original.pid, 'SIGKILL'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  fs.writeFileSync(${JSON.stringify(cleaned)}, 'yes');
  process.exit(${cleanupFails ? 1 : 0});
}
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid, fixture:process.env.HOME}));
setTimeout(() => process.exit(0), 10000);
`);
      await chmod(binary, 0o700);
      child = spawn(process.execPath, ["--import", "tsx", "scripts/smoke-zellij-session-config.ts", binary], {
        cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr!.on("data", (data) => { stderr = (stderr + data).slice(-65_536); });
      child.stdout!.resume();
      closed = new Promise<number | null>((done) => child!.once("close", done));
      const { fixture } = await waitForStartedMarker(marker, closed);
      child.kill("SIGTERM");
      expect(await closed).not.toBe(0);
      expect(stderr).toContain("AbortError");
      if (cleanupFails) expect(stderr).toContain("Zellij smoke cleanup failed");
      await expect(readFile(cleaned, "utf8")).resolves.toBe("yes");
      await expect(readFile(join(fixture, "session"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (child && closed && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        if (!await waitForClose(closed, SUPERVISOR_CLEANUP_GRACE_MS)) {
          child.kill("SIGKILL");
          await closed;
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});
