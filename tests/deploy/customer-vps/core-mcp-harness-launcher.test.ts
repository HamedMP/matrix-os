import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// User outcome: Matrix Core MCP usage rows name the harness that made the call.
// Fault detected: the credential-isolating launcher drops the harness label
// (it starts from `env -i`), or forwards an attacker-shaped label.
const launcherPath = "distro/customer-vps/host-bin/matrix-integrations-mcp";

async function runLauncher(args: string[]) {
  const fixtureDir = await mkdtemp(join(tmpdir(), "matrix-mcp-harness-"));
  try {
    const serverPath = join(fixtureDir, "server.cjs");
    await writeFile(serverPath, "console.log(JSON.stringify({args:process.argv.slice(2),harness:process.env.MATRIX_MCP_HARNESS??null}));");
    const launcher = (await readFile(launcherPath, "utf8"))
      .replace('NODE_BIN="/opt/matrix/runtime/node/bin/node"', `NODE_BIN="${process.execPath}"`)
      .replace('SERVER_PATH="/opt/matrix/app/packages/integrations-mcp/dist/cli.js"', `SERVER_PATH="${serverPath}"`);
    return spawnSync("bash", ["-c", launcher, "harness-fixture", ...args], {
      encoding: "utf8", timeout: 5_000,
      env: { PATH: process.env.PATH ?? "", MATRIX_AGENT_INTEGRATIONS_TOKEN: "a".repeat(64), MATRIX_MCP_HARNESS: "spoofed" },
    });
  } finally { await rm(fixtureDir, { recursive: true, force: true }); }
}

describe("Matrix Core MCP harness label through the stdio launcher", () => {
  it.each(["claude_code", "codex", "opencode", "hermes"])("forwards --harness=%s as MATRIX_MCP_HARNESS only", async harness => {
    const result = await runLauncher(["--require-scoped-capability", "--tool-surface=custom-mcp-call", `--harness=${harness}`]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ args: ["--tool-surface=custom-mcp-call"], harness });
  });

  it("never forwards an inherited, unflagged harness label", async () => {
    const result = await runLauncher(["--require-scoped-capability", "--tool-surface=custom-mcp-call"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ args: ["--tool-surface=custom-mcp-call"], harness: null });
  });

  it.each([["--harness=unknown"], ["--harness=codex", "--harness=codex"], ["--harness="]])("rejects %j before reading credentials", async (...args) => {
    const result = await runLauncher(args);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("unsupported launcher arguments");
  });
});
