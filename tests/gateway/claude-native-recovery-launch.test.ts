import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  canLaunchProtectedClaudeRecovery,
  spawnProtectedClaudeRecovery,
} from "../../packages/gateway/src/chat/claude-native-recovery-launch.js";
import { NATIVE_SHARED_BROWSER_TOOL } from "../../packages/gateway/src/chat/native-shared-browser-run.js";

const input = {
  command: "/opt/matrix/runtime/bin/claude", cwd: "/home/matrix/home/projects/alpha",
  env: { HOME: "/home/matrix", PATH: "/usr/bin", ANTHROPIC_API_KEY: "fixture-owner-key" },
  args: ["--setting-sources", "", "--settings", "{}", "--permission-mode", "default", "--strict-mcp-config",
    "--no-chrome", "--model", "fixture-model", "--print", "--output-format", "stream-json", "--verbose",
    "--include-partial-messages", "--input-format", "stream-json", "--permission-prompt-tool", "stdio"],
  transcript: Buffer.from('{"type":"user"}\n'),
};

function fixture() {
  const pipe = new PassThrough();
  const child = { kill: vi.fn(), stdio: [null, null, null, pipe] };
  const spawnScoped = vi.fn(() => child as never);
  return { child, pipe, spawnScoped };
}

describe("protected Claude native recovery launch", () => {
  it("pipes only bounded replay bytes through fd 3 and preserves the canonical cwd and profile", async () => {
    const { child, pipe, spawnScoped } = fixture();
    const chunks: Buffer[] = [];
    pipe.on("data", chunk => chunks.push(chunk));
    const ended = once(pipe, "end");
    expect(spawnProtectedClaudeRecovery(input, { spawnScoped })).toBe(child);
    await ended;
    expect(Buffer.concat(chunks)).toEqual(input.transcript);
    expect(spawnScoped).toHaveBeenCalledWith("/usr/bin/python3", [
      "-I", "-S", "-B", "/usr/local/libexec/matrix-claude-native-recovery/launch.py",
      input.command, ...input.args,
    ], { cwd: input.cwd, env: input.env, stdio: ["pipe", "pipe", "pipe", "pipe"], requireIsolation: true });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each([
    { command: "claude" }, { cwd: "relative" }, { env: { ...input.env, CLAUDE_CONFIG_DIR: "/other" } },
    { env: { ...input.env, MATRIX_AGENT_INTEGRATIONS_TOKEN: "run-capability" } },
    { args: [...input.args, "--mcp-config=/project/server.json"] }, { args: [...input.args, "--resume", "previous"] },
    { args: [...input.args, "--allowedTools", "Bash"] },
    { args: [...input.args, "a foreground prompt"] }, { transcript: Buffer.alloc(0) },
    { transcript: Buffer.alloc(4 * 1024 * 1024 + 1) },
  ])("rejects unsafe launch or handoff inputs before spawning", override => {
    const { spawnScoped } = fixture();
    expect(() => spawnProtectedClaudeRecovery({ ...input, ...override }, { spawnScoped })).toThrow("Protected Claude recovery unavailable");
    expect(spawnScoped).not.toHaveBeenCalled();
  });

  it("preserves only the exact canonical shared-browser presentation, with no idle MCP server or bearer", () => {
    const { child, spawnScoped } = fixture();
    const args = [...input.args, "--allowedTools", NATIVE_SHARED_BROWSER_TOOL];
    expect(spawnProtectedClaudeRecovery({ ...input, args }, { spawnScoped })).toBe(child);
    expect(spawnScoped.mock.calls[0]).toEqual([
      "/usr/bin/python3", ["-I", "-S", "-B", expect.any(String), input.command, ...args],
      expect.objectContaining({ env: input.env }),
    ]);
  });

  it("kills a partially spawned process when its owned transcript pipe fails", () => {
    const { child, pipe, spawnScoped } = fixture();
    spawnProtectedClaudeRecovery(input, { spawnScoped });
    pipe.emit("error", new Error("descriptor lost"));
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("rejects direct launch when the existing provider scope is unavailable", () => {
    vi.stubEnv("MATRIX_PROVIDER_PROCESS_ISOLATION", "0");
    try {
      expect(canLaunchProtectedClaudeRecovery()).toBe(false);
      expect(() => spawnProtectedClaudeRecovery(input)).toThrow("Protected Claude recovery unavailable");
    } finally { vi.unstubAllEnvs(); }
  });

  it("ships the helper in the host bin payload and installs it into the protected root for bootstrap, update, and rollback", async () => {
    const root = new URL("../../", import.meta.url);
    const [helper, bundle, updater, cloudInit, prereqs, standalone] = await Promise.all([
      "distro/customer-vps/host-bin/matrix-claude-native-recovery.py", "scripts/build-host-bundle.sh",
      "distro/customer-vps/host-bin/matrix-sync-agent", "distro/customer-vps/cloud-init.yaml",
      "distro/customer-vps/host-bin/matrix-prepare-host-prerequisites", "scripts/install-server.sh",
    ].map(path => readFile(new URL(path, root), "utf8")));
    const target = "/usr/local/libexec/matrix-claude-native-recovery/launch.py";
    expect(helper).toContain("os.memfd_create");
    expect(bundle).toContain("$STAGE_DIR/bin/matrix-claude-native-recovery.py");
    expect(updater).toContain(`record_update_file ${target} claude-native-recovery-helper`);
    expect(updater).toContain(`restore_update_file ${target} claude-native-recovery-helper`);
    expect(cloudInit).toContain("/opt/matrix/bin/matrix-prepare-host-prerequisites");
    expect(prereqs).toContain(target);
    expect(standalone).toContain(target);
  });
});
