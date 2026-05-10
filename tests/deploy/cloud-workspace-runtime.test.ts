import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

describe("cloud workspace runtime gates", () => {
  it("ships required coding workspace tools in the final container", () => {
    const dockerfile = readFileSync(join(root, "Dockerfile"), "utf-8");

    for (const tool of ["zellij", "tmux", "gh", "openssh-client", "bubblewrap", "git", "sudo", "code-server"]) {
      expect(dockerfile).toContain(tool);
    }
    for (const agentCli of ["@anthropic-ai/claude-code@latest", "@openai/codex@latest", "opencode-ai", "@mariozechner/pi-coding-agent"]) {
      expect(dockerfile).toContain(agentCli);
    }
    expect(dockerfile).toContain("hermes-agent/main/scripts/install.sh");
    expect(dockerfile).toContain("scripts/sync-matrix-agent-skills.sh");
  });

  it("syncs Matrix skills into Claude Code and Codex from canonical skill directories", () => {
    const dockerfile = readFileSync(join(root, "Dockerfile"), "utf-8");
    const entrypoint = readFileSync(join(root, "distro/docker-entrypoint.sh"), "utf-8");
    const devEntrypoint = readFileSync(join(root, "distro/docker-dev-entrypoint.sh"), "utf-8");
    const syncScript = readFileSync(join(root, "scripts/sync-matrix-agent-skills.sh"), "utf-8");

    expect(dockerfile).toContain("sync-matrix-agent-skills.sh");
    expect(entrypoint).toContain("sync-matrix-agent-skills.sh");
    expect(devEntrypoint).toContain("sync-matrix-agent-skills.sh");
    expect(syncScript).toContain(".agents/skills");
    expect(syncScript).toContain("agents/skills");
    expect(syncScript).toContain("agents/openai.yaml");
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

  it("seeds canonical agent skills, including dot-directories, on first boot", () => {
    const entrypoint = readFileSync(join(root, "distro/docker-entrypoint.sh"), "utf-8");
    const devEntrypoint = readFileSync(join(root, "distro/docker-dev-entrypoint.sh"), "utf-8");

    expect(entrypoint).toContain("cp -r /app/home/. \"$MATRIX_HOME/\"");
    expect(devEntrypoint).toContain("for dir in .agents agents system apps; do");
  });

  it("keeps Docker scenario health checks independent of default app builds", () => {
    const devEntrypoint = readFileSync(join(root, "distro/docker-dev-entrypoint.sh"), "utf-8");
    const dockerTestWorkflow = readFileSync(join(root, ".github/workflows/docker-test.yml"), "utf-8");

    expect(devEntrypoint).toContain("MATRIX_DEFAULT_APP_BUILD_MODE");
    expect(devEntrypoint).toContain("Skipping bundled default app build.");
    expect(dockerTestWorkflow).toContain("MATRIX_DEFAULT_APP_BUILD_MODE: skip");
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

    expect(docs).toContain("GitHub authentication");
    expect(docs).toContain("Data ownership");
    expect(docs).toContain("Review loops");
    expect(docs).toContain("Browser IDE");
    expect(docs).toContain("Sandboxing");
  });
});
