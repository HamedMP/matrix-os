import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
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
});
