import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

function writeSkill(root: string, dirName: string, skillName: string): void {
  const skillDir = join(root, dirName);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---
name: ${skillName}
description: ${skillName} test skill
version: 1.0.0
author: Matrix OS
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [Matrix OS]
---

# ${skillName}
`,
  );
}

function extractAgentSkillList(script: string): string[] {
  const match = script.match(/skills=\(\n(?<body>[\s\S]*?)\n\)/);
  if (!match?.groups?.body) {
    throw new Error("Agent installer skills array not found");
  }
  return match.groups.body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();
}

function extractHermesFallbackSkillList(script: string): string[] {
  const match = script.match(/for skill_dir in (?<body>[^;]+); do/);
  if (!match?.groups?.body) {
    throw new Error("Hermes installer fallback loop not found");
  }
  return match.groups.body.split(/\s+/).filter(Boolean).sort();
}

describe("Matrix coding-agent skill sync", () => {
  it("projects canonical Hermes-format skills into Matrix, Claude, Codex, and Hermes locations", () => {
    const root = resolve(mkdirSync(join(tmpdir(), `matrix-skills-sync-${Date.now()}`), { recursive: true }));
    const source = join(root, "skills", "matrix");
    const matrixHome = join(root, "matrix-home");
    const cliHome = join(root, "cli-home");
    const hermesHome = join(root, "hermes-home");

    try {
      writeSkill(source, "app-builder", "matrix-app-builder");
      writeSkill(source, "integrations", "matrix-integrations");

      mkdirSync(join(cliHome, ".codex", "skills", "matrix-old"), { recursive: true });
      writeFileSync(join(cliHome, ".codex", "skills", "matrix-old", ".matrix-os-managed"), "");

      execFileSync("bash", [join(process.cwd(), "scripts/sync-matrix-agent-skills.sh"), source], {
        env: {
          ...process.env,
          HOME: cliHome,
          MATRIX_HOME: matrixHome,
          HERMES_HOME: hermesHome,
          MATRIX_SKILL_TARGETS: "matrix,claude,codex,hermes",
        },
        stdio: "pipe",
      });

      const expectedTargets = [
        join(matrixHome, ".agents", "skills", "matrix-app-builder"),
        join(cliHome, ".agents", "skills", "matrix-app-builder"),
        join(cliHome, ".claude", "skills", "matrix-app-builder"),
        join(hermesHome, "skills", "matrix-app-builder"),
      ];

      for (const target of expectedTargets) {
        expect(existsSync(join(target, "SKILL.md"))).toBe(true);
        expect(lstatSync(target).isSymbolicLink()).toBe(true);
        expect(realpathSync(target)).toBe(realpathSync(join(source, "app-builder")));
      }

      expect(existsSync(join(cliHome, ".codex", "skills", "matrix-old"))).toBe(false);
      expect(readFileSync(join(cliHome, ".agents", "skills", "matrix-integrations", "SKILL.md"), "utf-8")).toContain(
        "name: matrix-integrations",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps manual skill installers aligned with the shipped Matrix skill pack", () => {
    const root = process.cwd();
    const shippedSkillDirs = readdirSync(join(root, "skills", "matrix"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    const agentInstaller = readFileSync(join(root, "scripts/install-agent-matrix-skills.sh"), "utf-8");
    const hermesInstaller = readFileSync(join(root, "scripts/install-hermes-matrix-skills.sh"), "utf-8");

    expect(extractAgentSkillList(agentInstaller)).toEqual(shippedSkillDirs);
    expect(extractHermesFallbackSkillList(hermesInstaller)).toEqual(shippedSkillDirs);
  });

  it("lets the Agent installer consume a direct skills/matrix source path", () => {
    const root = resolve(mkdirSync(join(tmpdir(), `matrix-agent-install-${Date.now()}`), { recursive: true }));
    const source = join(root, "skills", "matrix");
    const fakeAgent = join(root, "agent");
    const logPath = join(root, "agent.log");

    try {
      for (const skillDir of ["app-builder", "app-ui-patterns", "landing-design"]) {
        writeSkill(source, skillDir, `matrix-${skillDir}`);
      }

      writeFileSync(
        fakeAgent,
        `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${logPath}"
`,
      );
      chmodSync(fakeAgent, 0o755);

      execFileSync("bash", [join(process.cwd(), "scripts/install-agent-matrix-skills.sh"), source], {
        env: {
          ...process.env,
          AGENT_BIN: fakeAgent,
        },
        stdio: "pipe",
      });

      const log = readFileSync(logPath, "utf-8");
      expect(log).toContain(`skills install ${join(source, "app-builder")}`);
      expect(log).toContain(`skills install ${join(source, "app-ui-patterns")}`);
      expect(log).toContain(`skills install ${join(source, "landing-design")}`);
      expect(log).not.toContain("skills/matrix/skills/matrix");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lets the Hermes installer sync from a direct skills/matrix source path", () => {
    const root = resolve(mkdirSync(join(tmpdir(), `matrix-hermes-install-${Date.now()}`), { recursive: true }));
    const source = join(root, "skills", "matrix");
    const cliHome = join(root, "cli-home");
    const hermesHome = join(root, "hermes-home");
    const fakeHermes = join(root, "hermes");

    try {
      for (const skillDir of ["app-builder", "app-ui-patterns", "landing-design"]) {
        writeSkill(source, skillDir, `matrix-${skillDir}`);
      }

      writeFileSync(
        fakeHermes,
        `#!/usr/bin/env bash
exit 0
`,
      );
      chmodSync(fakeHermes, 0o755);

      execFileSync("bash", [join(process.cwd(), "scripts/install-hermes-matrix-skills.sh"), source], {
        env: {
          ...process.env,
          HERMES_BIN: fakeHermes,
          HERMES_HOME: hermesHome,
          HOME: cliHome,
        },
        stdio: "pipe",
      });

      for (const skillDir of ["app-builder", "app-ui-patterns", "landing-design"]) {
        const skillName = `matrix-${skillDir}`;
        const target = join(hermesHome, "skills", skillName);
        expect(existsSync(join(target, "SKILL.md"))).toBe(true);
        expect(lstatSync(target).isSymbolicLink()).toBe(true);
        expect(realpathSync(target)).toBe(realpathSync(join(source, skillDir)));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
