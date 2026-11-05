import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { createUnixSocketTempDir } from "../helpers/unix-socket-temp.js";

// Root can unlink the socket even in a 0500 directory.
it.skipIf(process.getuid?.() === 0)("keeps an idle supervisor reachable by SIGTERM after native close", async () => {
  const root = await createUnixSocketTempDir();
  const ipc = join(root, "ipc");
  const socket = join(ipc, "service");
  await mkdir(ipc, { mode: 0o700 });
  const fixture = fileURLToPath(new URL("./main-shutdown-child.fixture.ts", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", fixture, root], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const closed = once(child, "close");
  try {
    await vi.waitFor(() => expect(stdout, stderr).toContain("ready\n"), { timeout: 5000 });
    await chmod(ipc, 0o500);
    expect(child.kill("SIGTERM")).toBe(true);
    await vi.waitFor(() => expect(stderr).toContain("scope_runtime_supervisor_shutdown_failed: Error"));
    expect((await lstat(socket)).isSocket()).toBe(true);
    expect(stdout).not.toContain("controller closed");

    // Let the otherwise-idle child reach natural exit before attempting the retry.
    const idle = await Promise.race([closed, delay(250, "still running")]);
    expect(idle).toBe("still running");
    await chmod(ipc, 0o700);
    expect(child.kill("SIGTERM")).toBe(true);
    await vi.waitFor(() => expect(child.exitCode).toBe(0));
    expect(await closed).toEqual([0, null]);
    expect(stdout.split("\n").filter(line => line === "controller closed")).toHaveLength(1);
    await expect(lstat(socket)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
    await chmod(ipc, 0o700);
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
