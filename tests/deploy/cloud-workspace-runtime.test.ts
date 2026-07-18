import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CODEX_VERIFIED_VERSION } from "../../packages/contracts/src/index.js";

const root = process.cwd();

describe("cloud workspace runtime gates", () => {
  it("ships required coding workspace tools in the final container", () => {
    const dockerfile = readFileSync(join(root, "Dockerfile"), "utf-8");

    for (const tool of ["zellij", "tmux", "gh", "openssh-client", "bubblewrap", "socat", "git", "sudo", "code-server"]) {
      expect(dockerfile).toContain(tool);
    }
    for (const agentCli of [
      "@anthropic-ai/claude-code@latest",
      `ARG CODEX_VERSION=${CODEX_VERIFIED_VERSION}`,
      '"@openai/codex@${CODEX_VERSION}"',
      "OPENCODE_AI_VERSION=latest",
      "PI_CODING_AGENT_VERSION=latest",
      '"opencode-ai@${OPENCODE_AI_VERSION}"',
      '"@earendil-works/pi-coding-agent@${PI_CODING_AGENT_VERSION}"',
    ]) {
      expect(dockerfile).toContain(agentCli);
    }
    expect(dockerfile).toContain("npm install -g --ignore-scripts");
    expect(dockerfile).toContain("hermes-agent/main/scripts/install.sh");
  });

  it("lets the non-root Matrix user run sudo-based project installers", () => {
    const dockerfile = readFileSync(join(root, "Dockerfile"), "utf-8");
    const devDockerfile = readFileSync(join(root, "Dockerfile.dev"), "utf-8");

    for (const source of [dockerfile, devDockerfile]) {
      expect(source).toContain("sudo");
      expect(source).toContain("matrixos ALL=(ALL) NOPASSWD:ALL");
      expect(source).toContain("chmod 0440 /etc/sudoers.d/matrixos");
    }
  });

  it("creates workspace-owned recovery directories on startup", () => {
    const entrypoint = readFileSync(join(root, "distro/docker-entrypoint.sh"), "utf-8");

    for (const dir of [
      "projects",
      "system/sessions",
      "system/session-output",
      "system/reviews",
      "system/ops",
      "system/zellij/layouts",
      "system/agent-scratch",
      "system/code-server",
    ]) {
      expect(entrypoint).toContain(`$MATRIX_HOME/${dir}`);
    }
  });

  it("extends health output without leaking filesystem paths or secrets", () => {
    const server = readFileSync(join(root, "packages/gateway/src/server.ts"), "utf-8");

    for (const key of ["workspace", "sessions", "reviews", "sandbox", "browserIde"]) {
      expect(server).toContain(`${key}:`);
    }
    expect(server).not.toContain("MATRIX_HOME:");
    expect(server).not.toContain("ANTHROPIC_API_KEY");
  });

  it("publishes public cloud coding workspace docs", () => {
    const docsPath = join(root, "www/content/docs/guide/cloud-coding.mdx");
    const docs = existsSync(docsPath) ? readFileSync(docsPath, "utf-8") : "";
    const runbook = readFileSync(join(root, "docs/dev/coding-agent-shells.md"), "utf-8");
    const currentState = readFileSync(join(root, "specs/105-coding-agent-shells/current-state.md"), "utf-8");

    expect(docs).toContain("GitHub authentication");
    expect(docs).toContain("Data ownership");
    expect(docs).toContain("Review loops");
    expect(docs).toContain("Browser IDE");
    expect(docs).toContain("Sandboxing");
    expect(docs).toContain("AppArmor");
    expect(runbook).toContain("`on_request` and `never` map to `dontAsk`");
    expect(runbook).toContain("scoped `Edit(...)` allow rules");
    expect(docs).toContain("Built-in file edits remain available only inside the selected worktree");
    expect(runbook).toContain('Prompted thread launches add `--print`');
    expect(runbook).toContain("workspace trust prompt");
    expect(runbook).toContain("shared Git metadata directory");
    expect(currentState).toContain("stale unowned scratch directories");
    expect(runbook).toContain("AppArmor profile");
    expect(runbook).not.toContain("map to manual approval");
    expect(currentState).not.toContain("Claude registry-only");
    expect(currentState).not.toContain("thread creation remains fail-closed until [#893]");
  });
});
