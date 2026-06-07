import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanAgentAuth } from "../../src/cli/agent-auth-scan.js";

describe("agent auth scan", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "matrix-agent-auth-scan-"));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it("detects supported local AI agent credential files without reading secrets into output", async () => {
    await mkdir(join(homeDir, ".codex"), { recursive: true });
    await writeFile(join(homeDir, ".codex/auth.json"), JSON.stringify({ access_token: "codex-secret" }));
    await mkdir(join(homeDir, ".claude"), { recursive: true });
    await writeFile(join(homeDir, ".claude/.credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "claude-secret" } }));
    await mkdir(join(homeDir, ".local/share/opencode"), { recursive: true });
    await writeFile(join(homeDir, ".local/share/opencode/auth.json"), JSON.stringify({ token: "opencode-secret" }));
    await mkdir(join(homeDir, ".pi/agent"), { recursive: true });
    await writeFile(join(homeDir, ".pi/agent/auth.json"), JSON.stringify({ token: "pi-secret" }));

    const result = await scanAgentAuth({ homeDir });

    expect(result.providers).toEqual([
      { provider: "codex", status: "found", localPath: "~/.codex/auth.json", remotePath: ".codex/auth.json", transferable: true },
      { provider: "claude-code", status: "found", localPath: "~/.claude/.credentials.json", remotePath: ".claude/.credentials.json", transferable: true },
      { provider: "opencode", status: "found", localPath: "~/.local/share/opencode/auth.json", remotePath: ".local/share/opencode/auth.json", transferable: true },
      { provider: "pi", status: "found", localPath: "~/.pi/agent/auth.json", remotePath: ".pi/agent/auth.json", transferable: true },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/secret/);
  });

  it("reports OpenCode config and Claude Keychain as non-transferable guidance", async () => {
    await mkdir(join(homeDir, ".config/opencode"), { recursive: true });
    await writeFile(join(homeDir, ".config/opencode/opencode.json"), JSON.stringify({ provider: {} }));

    const result = await scanAgentAuth({ homeDir, includeMacOsKeychainHint: true });

    expect(result.providers).toEqual(expect.arrayContaining([
      {
        provider: "claude-code-keychain",
        status: "manual",
        localPath: "macOS Keychain: Claude Code-credentials",
        remotePath: null,
        transferable: false,
      },
      {
        provider: "opencode-config",
        status: "manual",
        localPath: "~/.config/opencode/opencode.json",
        remotePath: null,
        transferable: false,
      },
    ]));
  });

  it("treats inaccessible or malformed credential paths as missing instead of crashing", async () => {
    await writeFile(join(homeDir, ".pi"), "not a directory");

    const result = await scanAgentAuth({ homeDir });

    expect(result.providers.find((provider) => provider.provider === "pi")).toEqual({
      provider: "pi",
      status: "missing",
      localPath: "~/.pi/agent/auth.json",
      remotePath: ".pi/agent/auth.json",
      transferable: false,
    });
  });
});
