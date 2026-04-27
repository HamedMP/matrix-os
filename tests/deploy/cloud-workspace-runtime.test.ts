import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

describe("cloud workspace runtime gates", () => {
  it("ships required coding workspace tools in the final container", () => {
    const dockerfile = readFileSync(join(root, "Dockerfile"), "utf-8");

    for (const tool of ["zellij", "tmux", "gh", "openssh-client", "bubblewrap", "git", "code-server"]) {
      expect(dockerfile).toContain(tool);
    }
    for (const agentCli of ["@anthropic-ai/claude-code", "@openai/codex", "opencode-ai", "@mariozechner/pi-coding-agent"]) {
      expect(dockerfile).toContain(agentCli);
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

    expect(docs).toContain("GitHub authentication");
    expect(docs).toContain("Data ownership");
    expect(docs).toContain("Review loops");
    expect(docs).toContain("Browser IDE");
    expect(docs).toContain("Sandboxing");
  });
});
