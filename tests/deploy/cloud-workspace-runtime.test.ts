import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    const hashScript = readFileSync(join(root, "scripts/bundled-skill-hashes.sh"), "utf-8");

    expect(dockerfile).toContain("sync-matrix-agent-skills.sh");
    expect(dockerfile).toContain("bundled-skill-hashes.sh");
    expect(entrypoint).toContain("sync-matrix-agent-skills.sh");
    expect(devEntrypoint).toContain("sync-matrix-agent-skills.sh");
    expect(syncScript).toContain(".agents/skills");
    expect(syncScript).toContain("agents/skills");
    expect(syncScript).toContain('cp -a "$source/." "$out/"');
    expect(syncScript).toContain("agents/openai.yaml");
    expect(entrypoint).toContain("source /app/scripts/bundled-skill-hashes.sh");
    expect(devEntrypoint).toContain("source /app/scripts/bundled-skill-hashes.sh");
    expect(hashScript).toContain("is_known_bundled_skill_hash");
    expect(hashScript).toContain("baceb1ffe57e46ba95d21b310cb0a49917bd29b8cd18ca53eb2784986c0f17ea");
    expect(hashScript).toContain("3ead6fd9db4c992778a1ea3aad13a0cd56f8aa33b608bf8a80bc721edc7131ee");
    expect(entrypoint).toContain("Matrix skill sync failed; continuing startup");
    expect(devEntrypoint).toContain("Matrix skill sync failed; continuing startup");
    expect(entrypoint).toContain("Bundled directory skill sync failed; continuing startup");
    expect(devEntrypoint).toContain("Bundled directory skill sync failed; continuing startup");
  });

  it("keeps bundled skill upgrade hashes aligned across startup paths", () => {
    const hashScript = readFileSync(join(root, "scripts/bundled-skill-hashes.sh"), "utf-8");
    const sources = [
      readFileSync(join(root, "distro/docker-entrypoint.sh"), "utf-8"),
      readFileSync(join(root, "distro/docker-dev-entrypoint.sh"), "utf-8"),
      readFileSync(join(root, "distro/customer-vps/host-bin/matrix-gateway"), "utf-8"),
    ];
    const hashes = [...hashScript.matchAll(/integrations:[a-f0-9]{64}/g)].map((match) => match[0]);

    expect(hashes).toEqual([
      "integrations:baceb1ffe57e46ba95d21b310cb0a49917bd29b8cd18ca53eb2784986c0f17ea",
      "integrations:3ead6fd9db4c992778a1ea3aad13a0cd56f8aa33b608bf8a80bc721edc7131ee",
    ]);
    for (const source of sources) {
      expect(source).toContain("bundled-skill-hashes.sh");
      expect(source).not.toMatch(/integrations:[a-f0-9]{64}/);
    }
  });

  it("copies directory skill support files into Claude Code and Codex mirrors", () => {
    const tmpRoot = mkdtempSync(join(root, ".tmp-skill-sync-"));
    try {
      const matrixHome = join(tmpRoot, "home");
      const targetHome = join(tmpRoot, "target");
      const sourceSkill = join(matrixHome, ".agents/skills/integrations");
      mkdirSync(join(sourceSkill, "references"), { recursive: true });
      writeFileSync(
        join(sourceSkill, "SKILL.md"),
        "---\nname: integrations\ndescription: Demo integration skill\n---\n# Integrations\n",
      );
      writeFileSync(join(sourceSkill, "references/guide.md"), "supporting resource\n");

      execFileSync("bash", [join(root, "scripts/sync-matrix-agent-skills.sh"), matrixHome, targetHome]);

      for (const toolRoot of [".claude", ".codex"]) {
        const syncedSkill = join(targetHome, toolRoot, "skills/matrix-integrations");
        expect(readFileSync(join(syncedSkill, "SKILL.md"), "utf-8")).toContain("name: matrix-integrations");
        expect(readFileSync(join(syncedSkill, "references/guide.md"), "utf-8")).toBe("supporting resource\n");
      }
      expect(readFileSync(join(targetHome, ".codex/skills/matrix-integrations/agents/openai.yaml"), "utf-8")).toContain(
        'display_name: "Matrix: Integrations"',
      );
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("tracks canonical dot-directory skills in the home template manifest", () => {
    const manifest = JSON.parse(readFileSync(join(root, "home/.template-manifest.json"), "utf-8"));
    const skill = readFileSync(join(root, "home/.agents/skills/integrations/SKILL.md"));
    const skillHash = createHash("sha256").update(skill).digest("hex");

    expect(manifest).toHaveProperty(".agents/skills/integrations/SKILL.md");
    expect(manifest[".agents/skills/integrations/SKILL.md"]).toBe(skillHash);
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

  it("builds the kernel package before Docker dev gateway startup", () => {
    const devEntrypoint = readFileSync(join(root, "distro/docker-dev-entrypoint.sh"), "utf-8");

    expect(devEntrypoint).toContain("build_kernel_package_if_needed");
    expect(devEntrypoint).toContain("/app/packages/kernel/dist/index.js");
    expect(devEntrypoint).toContain("pnpm --filter '@matrix-os/kernel' build");
  });

  it("preseeds shell Next generated types before dropping privileges", () => {
    const devEntrypoint = readFileSync(join(root, "distro/docker-dev-entrypoint.sh"), "utf-8");
    const nextEnv = readFileSync(join(root, "shell/next-env.d.ts"), "utf-8");

    expect(nextEnv).toContain('/// <reference types="next" />');
    expect(nextEnv).toContain('/// <reference types="next/image-types/global" />');
    expect(devEntrypoint).toContain("ensure_shell_next_env");
    expect(devEntrypoint).toContain('chown matrixos:matrixos "$next_env"');
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
