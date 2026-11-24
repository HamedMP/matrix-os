import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentLauncher } from "../../packages/gateway/src/agent-launcher.js";
import { codexProviderEventPath } from "../../packages/gateway/src/coding-agents/codex-event-bridge.js";

// Exercises the production app-server runner with the payload shapes that changed in
// Codex 0.170.0 (display union) and 0.171.0 (MCP registration scope, bioPolicy). The
// fixture validates both directions against the retained exact 0.171.0 schema.
describe("Codex 0.170-0.171 notification compatibility", () => {
  it.each(["completed", "failed"])("preserves %s outcomes without treating display or scope metadata as authority", async status => {
    const home = await mkdtemp("/tmp/codex-0171-runtime-");
    const events = codexProviderEventPath(home, "sess_codex_0171_1");
    const provider = resolve("tests/fixtures/codex-0171-provider.mjs");
    const executable = join(home, "codex");
    await writeFile(executable, `#!/bin/sh
if [ "$1" = --version ]; then
  echo 'codex-cli 0.171.0'
  exit 0
fi
exec "${process.execPath}" "${provider}" "$@"
`, { mode: 0o700 });
    const launcher = createAgentLauncher({ codexExecutable: executable });
    const launch = await launcher.buildLaunch({
      agent: "codex", cwd: home, providerEventPath: events, prompt: "Compatibility fixture",
      approvalPolicy: "on-request", sandbox: { enabled: true, mode: "workspace-write", writableRoots: [home] },
    });
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...launch.env, CODEX_0171_FIXTURE_STATUS: status },
    });
    let stderr = "";
    child.stderr.on("data", data => { stderr = (stderr + data.toString()).slice(-4000); });
    const timeout = setTimeout(() => child.kill("SIGTERM"), 8_000);
    try {
      const code = await new Promise<number | null>((resolveClose, reject) => {
        child.once("error", reject);
        child.once("close", resolveClose);
      });
      expect(stderr).not.toContain("codex-0171 fixture rejected");
      expect(code, stderr).toBe(status === "completed" ? 0 : 1);
      const raw = await readFile(events, "utf8");
      expect(raw, stderr).not.toBe("");
      const transcript = raw.trim().split("\n").map(line => JSON.parse(line));
      expect(transcript).toContainEqual(expect.objectContaining({ type: status === "completed" ? "turn.completed" : "turn.failed" }));
      expect(raw).toContain("Safe provider answer.");
      expect(raw).toContain("Use fixture.lookup");
      expect(raw).not.toMatch(/trustedAccess|private-registration-scope|environmentId|private bio policy detail/);
      expect(transcript.some(event => event.type === "matrix.codex.approval.requested")).toBe(false);
    } finally {
      clearTimeout(timeout);
      child.kill("SIGTERM");
      await rm(home, { recursive: true, force: true });
    }
  });
});

it("rejects a structured Codex launch when the selected executable is unverified", async () => {
  const launcher = createAgentLauncher({
    runCommand: async () => ({ stdout: "codex-cli 0.168.0", stderr: "" }),
  });
  await expect(launcher.buildLaunch({
    agent: "codex",
    cwd: "/tmp",
    prompt: "Inspect the workspace",
    providerEventPath: "/tmp/unsupported-codex.jsonl",
    sandbox: { enabled: true, mode: "read-only" },
  })).rejects.toThrow("Codex provider version is not verified");
});
