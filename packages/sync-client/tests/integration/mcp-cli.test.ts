import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("serves MCP through the published entry and exits cleanly after stdin closes", async () => {
  const child = spawn(process.execPath, [
    fileURLToPath(new URL("../../bin/matrix.mjs", import.meta.url)), "mcp", "serve",
  ], { env: { ...process.env, MATRIX_NO_TELEMETRY: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  const timer = setTimeout(() => child.kill("SIGTERM"), 8_000);
  try {
    const exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    child.stdout.on("data", (data) => {
      stdout += data;
      if (stdout.includes("\"id\":1")) child.stdin.end();
    });
    child.stderr.on("data", (data) => { stderr += data; });
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    }) + "\n");
    expect(await exited).toEqual({ code: 0, signal: null });
    expect(JSON.parse(stdout).result.serverInfo.name).toBe("matrix-remote-computer");
    expect(stderr).toBe("");
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
}, 10_000);
