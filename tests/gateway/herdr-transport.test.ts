import { chmod, copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { HerdrTransportError } from "@matrix-os/herdr-core-client/session-host";
import { createHerdrAdapter } from "../../packages/gateway/src/herdr/adapter.js";
import { createHerdrCoreTransport } from "../../packages/gateway/src/herdr/transport.js";

const roots: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fakeBinary() {
  const root = await mkdtemp(join(tmpdir(), "matrix-herdr-bin-"));
  roots.push(root);
  const bin = join(root, "herdr-core");
  await copyFile(fileURLToPath(new URL("./fixtures/fake-herdr-core-bin.mjs", import.meta.url)), bin);
  await chmod(bin, 0o755);
  return { bin, pidFile: join(root, "pid") };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function until(check: () => boolean | Promise<boolean>, ms = 2_000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("herdr-core connect transport", () => {
  it("reports not-installed when the binary is missing", async () => {
    const transport = createHerdrCoreTransport({ bin: join(tmpdir(), "no-such-herdr-core-binary") });
    cleanups.push(() => transport.close());
    await expect(transport.open()).rejects.toEqual(new HerdrTransportError("not-installed"));
  });

  it("lists terminals through a spawned `herdr-core connect` and kills it on close", async () => {
    const { bin, pidFile } = await fakeBinary();
    const transport = createHerdrCoreTransport({ bin, env: { ...process.env, FAKE_HERDR_PID_FILE: pidFile } });
    const adapter = createHerdrAdapter({ open: () => transport.open(), closeTransport: () => transport.close() });
    cleanups.push(() => adapter.close());

    expect(await adapter.list()).toMatchObject({
      available: true,
      status: "ready",
      sessions: [{ id: "t1", title: "claude", status: "working" }, { id: "t2", title: "shell", status: null }],
    });

    const pid = Number(await readFile(pidFile, "utf8"));
    expect(alive(pid)).toBe(true);
    await adapter.close();
    await until(() => !alive(pid));
  });

  it("kills the child when the socket is destroyed", async () => {
    const { bin, pidFile } = await fakeBinary();
    const transport = createHerdrCoreTransport({ bin, env: { ...process.env, FAKE_HERDR_PID_FILE: pidFile } });
    cleanups.push(() => transport.close());
    const socket = await transport.open();
    await until(() => readFile(pidFile, "utf8").then((text) => text.length > 0, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    }));
    const pid = Number(await readFile(pidFile, "utf8"));
    socket.destroy();
    await until(() => !alive(pid));
    expect(transport.children()).toBe(0);
  });
});
