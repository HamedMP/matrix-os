import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { codexProviderEventPath } from "../../packages/gateway/src/coding-agents/codex-event-bridge.js";

// Exercises the production app-server runner with the payload shapes that changed in
// Codex 0.170.0 (display union) and 0.171.0 (MCP registration scope, bioPolicy). The
// fixture validates both directions against the retained exact 0.171.0 schema.
describe("Codex 0.170-0.171 notification compatibility", () => {
  it.each(["completed", "failed"])("preserves %s outcomes without treating display or scope metadata as authority", async status => {
    const home = await mkdtemp("/tmp/codex-0171-runtime-");
    const events = codexProviderEventPath(home, "sess_codex_0171_1");
    const config = Buffer.from(JSON.stringify({ prompt: "Compatibility fixture", approvalPolicy: "on-request", sandbox: "workspace-write", writableRoots: [home] })).toString("base64");
    const runner = resolve("packages/gateway/src/coding-agents/codex-app-server-runner.mjs");
    const provider = resolve("tests/fixtures/codex-0171-provider.mjs");
    const child = spawn(process.execPath, [runner, events, process.version.slice(1), process.execPath, provider, config], {
      cwd: home, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CODEX_0171_FIXTURE_STATUS: status },
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
