import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCodexControlClient } from "../../packages/gateway/src/coding-agents/codex-control-client.js";
import { codexProviderEventPath } from "../../packages/gateway/src/coding-agents/codex-event-bridge.js";

async function waitFor(path: string, text: string) {
  for (let attempt = 0; attempt < 250; attempt++) {
    try { if ((await readFile(path, "utf8")).includes(text)) return; }
    catch (error: unknown) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for runner output");
}

function control(path: string, providerThreadId: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path });
    let output = "";
    socket.setEncoding("utf8");
    socket.setTimeout(2_000, () => socket.destroy(new Error("control timeout")));
    socket.once("error", reject);
    socket.once("connect", () => socket.end(`${JSON.stringify({ type: "hibernate", providerThreadId, clientRequestId: "req_hibernate_test" })}\n`));
    socket.on("data", (chunk) => { output += chunk; });
    socket.once("end", () => { try { resolve(JSON.parse(output)); } catch (error) { reject(error); } });
  });
}

describe("Codex idle runtime handshake", () => {
  it.each([false, true])("hibernates only after work has completed (active=%s)", async (active) => {
    const home = await mkdtemp("/tmp/codex-idle-");
    const eventPath = codexProviderEventPath(home, "sess_idle");
    const config = Buffer.from(JSON.stringify({ prompt: "Small task", approvalPolicy: "never", sandbox: "read-only", writableRoots: [home] })).toString("base64");
    const child = spawn(process.execPath, [join(process.cwd(), "packages/gateway/src/coding-agents/codex-app-server-runner.mjs"),
      eventPath, process.version.slice(1), process.execPath, join(process.cwd(), "tests/fixtures/codex-idle-provider.mjs"), config], {
      cwd: home, stdio: ["pipe", "ignore", "pipe"], env: { ...process.env, ...(active ? { MATRIX_TEST_KEEP_ACTIVE: "1" } : {}) },
    });
    const exited = once(child, "close");
    try {
      await waitFor(eventPath, active ? "Task started" : "turn.completed");
      expect(await readFile(eventPath, "utf8")).toContain('"type":"thread.started","thread_id":"native_idle_test"');
      await expect(control(eventPath.replace(/\.jsonl$/, ".sock"), "wrong_native_id")).resolves.toEqual({ ok: false });
      const hibernate = () => createCodexControlClient({ homePath: home }).hibernate({
        sessionId: "sess_idle", providerThreadId: "native_idle_test", clientRequestId: "req_hibernate_client",
      });
      if (active) await expect(hibernate()).rejects.toThrow();
      else await expect(hibernate()).resolves.toBeUndefined();
      if (!active) expect((await exited)[0]).toBe(0);
      else expect(child.exitCode).toBeNull();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await exited;
      await rm(home, { recursive: true, force: true });
    }
  });
});
