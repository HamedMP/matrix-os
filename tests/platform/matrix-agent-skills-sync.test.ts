import { execFileSync, spawnSync } from "node:child_process";
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
import { CORE_REPO_MAX_SKILL_NAME_LENGTH } from "../../packages/contracts/src/core-repo.js";

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
      writeSkill(source, "jev-email-triage", "matrix-jev-email-triage");

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
      for (const target of [
        join(matrixHome, ".agents", "skills", "matrix-jev-email-triage"),
        join(cliHome, ".agents", "skills", "matrix-jev-email-triage"),
        join(cliHome, ".claude", "skills", "matrix-jev-email-triage"),
        join(hermesHome, "skills", "matrix-jev-email-triage"),
      ]) {
        expect(realpathSync(target)).toBe(realpathSync(join(source, "jev-email-triage")));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refreshes vendored skills across releases while preserving user-owned collisions", () => {
    const root = resolve(mkdirSync(join(tmpdir(), `matrix-vendored-sync-${Date.now()}`), { recursive: true }));
    const previousSource = join(root, "previous", "matrix");
    const source = join(root, "release", "matrix");
    const cliHome = join(root, "cli-home");
    const targets = [join(cliHome, ".agents", "skills"), join(cliHome, ".claude", "skills"), join(root, "hermes", "skills")];
    try {
      writeSkill(previousSource, "animate", "animate");
      writeFileSync(join(previousSource, "animate", ".matrix-os-managed"), "vendored skill\n");
      writeSkill(source, "animate", "animate");
      writeSkill(source, "apple-design", "apple-design");
      writeFileSync(join(source, "animate", ".matrix-os-managed"), "vendored skill\n");
      for (const target of targets) {
        mkdirSync(target, { recursive: true });
        execFileSync("ln", ["-s", join(previousSource, "animate"), join(target, "animate")]);
        writeSkill(target, "apple-design", "apple-design");
        const userSkill = join(target, "apple-design", "SKILL.md");
        writeFileSync(userSkill, readFileSync(userSkill, "utf-8").replace("author: Matrix OS", "author: Owner"));
        mkdirSync(join(target, "retired-vendored"));
        writeFileSync(join(target, "retired-vendored", ".matrix-os-managed"), "vendored skill\n");
      }
      execFileSync("bash", [join(process.cwd(), "scripts/sync-matrix-agent-skills.sh"), source], {
        env: { ...process.env, HOME: cliHome, MATRIX_HOME: join(root, "matrix-home"), HERMES_HOME: join(root, "hermes"), MATRIX_SKILL_TARGETS: "claude,codex,hermes" },
        stdio: "pipe",
      });
      for (const target of targets) {
        expect(realpathSync(join(target, "animate"))).toBe(realpathSync(join(source, "animate")));
        expect(readFileSync(join(target, "apple-design", "SKILL.md"), "utf-8")).toContain("author: Owner");
        expect(lstatSync(join(target, "apple-design")).isSymbolicLink()).toBe(false);
        expect(existsSync(join(target, "retired-vendored"))).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Fault: the gateway-start (default) sync deletes org skills, or namespace mode touches personal or public skills.
  it("keeps org-namespaced skills separate from the Matrix pack and from personal skills", () => {
    const root = resolve(mkdirSync(join(tmpdir(), `matrix-org-skills-${Date.now()}`), { recursive: true }));
    const source = join(root, "skills", "matrix");
    const orgRoot = join(root, "matrix-core", "org_acme1");
    const orgSkills = join(orgRoot, "releases", "a", ".matrix-skills");
    const home = join(root, "home");
    const script = join(process.cwd(), "scripts/sync-matrix-agent-skills.sh");
    const run = (env: Record<string, string>) => execFileSync("bash", [script], {
      env: { ...process.env, HOME: home, MATRIX_HOME: home, MATRIX_SKILL_TARGETS: "claude", ...env }, stdio: "pipe" });
    const skills = join(home, ".claude", "skills");
    try {
      writeSkill(source, "app-builder", "matrix-app-builder");
      writeSkill(orgSkills, "org-acme-deploy", "org-acme-deploy");
      writeSkill(orgSkills, "sneaky", "matrix-app-builder");
      writeSkill(skills, "org-acme-notes", "org-acme-notes");
      // What namespace mode's copy fallback leaves where symlinks are unavailable.
      writeSkill(skills, "org-other-copied", "org-other-copied");
      writeFileSync(join(skills, "org-other-copied", ".matrix-os-managed"), "");
      run({ MATRIX_SKILLS_SOURCE: orgSkills, MATRIX_SKILL_NAMESPACE: "org-acme-", MATRIX_SKILL_OWNED_ROOT: orgRoot });
      run({ MATRIX_SKILLS_SOURCE: source });
      expect(existsSync(join(skills, "org-other-copied", "SKILL.md"))).toBe(true);
      expect(realpathSync(join(skills, "org-acme-deploy"))).toBe(realpathSync(join(orgSkills, "org-acme-deploy")));
      expect(realpathSync(join(skills, "matrix-app-builder"))).toBe(realpathSync(join(source, "app-builder")));
      expect(lstatSync(join(skills, "org-acme-notes")).isSymbolicLink()).toBe(false);

      // An empty org source unlinks only that org's own entries.
      const empty = join(root, "empty");
      mkdirSync(empty);
      run({ MATRIX_SKILLS_SOURCE: empty, MATRIX_SKILL_NAMESPACE: "org-acme-", MATRIX_SKILL_OWNED_ROOT: orgRoot });
      expect(existsSync(join(skills, "org-acme-deploy"))).toBe(false);
      expect(existsSync(join(skills, "org-acme-notes", "SKILL.md"))).toBe(true);
      expect(existsSync(join(skills, "matrix-app-builder", "SKILL.md"))).toBe(true);
      expect(() => run({ MATRIX_SKILLS_SOURCE: empty, MATRIX_SKILL_NAMESPACE: "../", MATRIX_SKILL_OWNED_ROOT: orgRoot })).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Fault: org `acme` deletes copied skills of org `acme-tools` (`org-acme-tools-*` matches `org-acme-*`).
  it("owns a copied org skill only when its marker names this org root", () => {
    const root = resolve(mkdirSync(join(tmpdir(), `matrix-org-marker-${Date.now()}`), { recursive: true }));
    const acmeRoot = join(root, "matrix-core", "org_acme1");
    const toolsRoot = join(root, "matrix-core", "org_tools1");
    const home = join(root, "home");
    const skills = join(home, ".claude", "skills");
    const empty = join(root, "empty");
    const script = join(process.cwd(), "scripts/sync-matrix-agent-skills.sh");
    try {
      mkdirSync(acmeRoot, { recursive: true });
      mkdirSync(toolsRoot, { recursive: true });
      mkdirSync(empty);
      writeSkill(skills, "org-acme-tools-deploy", "org-acme-tools-deploy");
      writeFileSync(join(skills, "org-acme-tools-deploy", ".matrix-os-managed"), `${realpathSync(toolsRoot)}\n`);
      writeSkill(skills, "org-acme-review", "org-acme-review");
      writeFileSync(join(skills, "org-acme-review", ".matrix-os-managed"), `${realpathSync(acmeRoot)}\n`);
      execFileSync("bash", [script], { env: { ...process.env, HOME: home, MATRIX_HOME: home, MATRIX_SKILL_TARGETS: "claude",
        MATRIX_SKILLS_SOURCE: empty, MATRIX_SKILL_NAMESPACE: "org-acme-", MATRIX_SKILL_OWNED_ROOT: acmeRoot }, stdio: "pipe" });
      expect(existsSync(join(skills, "org-acme-tools-deploy", "SKILL.md"))).toBe(true);
      expect(existsSync(join(skills, "org-acme-review"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Fault: an org skill over the combined name limit disappears without any report.
  it("reports org skills whose combined name is over the limit", () => {
    const root = resolve(mkdirSync(join(tmpdir(), `matrix-org-long-${Date.now()}`), { recursive: true }));
    const orgRoot = join(root, "matrix-core", "org_acme1");
    const source = join(orgRoot, "releases", "a", ".matrix-skills");
    const home = join(root, "home");
    const long = `org-acme-${"x".repeat(92)}`;
    // The script and the installer enforce the same combined limit.
    expect(long.length).toBe(CORE_REPO_MAX_SKILL_NAME_LENGTH + 1);
    try {
      writeSkill(source, long, long);
      writeSkill(source, "org-acme-ok", "org-acme-ok");
      const result = spawnSync("bash", [join(process.cwd(), "scripts/sync-matrix-agent-skills.sh")], { encoding: "utf8",
        env: { ...process.env, HOME: home, MATRIX_HOME: home, MATRIX_SKILL_TARGETS: "claude",
          MATRIX_SKILLS_SOURCE: source, MATRIX_SKILL_NAMESPACE: "org-acme-", MATRIX_SKILL_OWNED_ROOT: orgRoot } });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain(`Org skill not installed (invalid name or over 100 characters): ${long}`);
      expect(existsSync(join(home, ".claude", "skills", "org-acme-ok", "SKILL.md"))).toBe(true);
      expect(existsSync(join(home, ".claude", "skills", long))).toBe(false);
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

  it("preserves owner-named aliases into current and previous Matrix sources", () => {
    const root = resolve(mkdirSync(join(tmpdir(), `matrix-skill-aliases-${Date.now()}`), { recursive: true }));
    const source = join(root, "current", "matrix");
    const previousSource = join(root, "previous", "matrix");
    const cliHome = join(root, "cli-home");
    const matrixHome = join(root, "matrix-home");
    const hermesHome = join(root, "hermes-home");
    const targets = [join(matrixHome, ".agents", "skills"), join(matrixHome, ".claude", "skills"),
      join(cliHome, ".agents", "skills"), join(cliHome, ".claude", "skills"),
      join(cliHome, ".codex", "skills"), join(hermesHome, "skills")];
    try {
      writeSkill(source, "app-builder", "matrix-app-builder");
      writeSkill(source, "animate", "animate");
      writeFileSync(join(source, "animate", ".matrix-os-managed"), "managed snapshot\n");
      writeSkill(previousSource, "animate", "animate");
      writeFileSync(join(previousSource, "animate", ".matrix-os-managed"), "managed snapshot\n");
      for (const target of targets) {
        mkdirSync(target, { recursive: true });
        for (const [name, src] of [["my-builder", join(source, "app-builder")], ["my-motion", join(source, "animate")],
          ["previous-motion", join(previousSource, "animate")]]) {
          execFileSync("ln", ["-s", realpathSync(src), join(target, name)]);
        }
      }
      execFileSync("bash", [join(process.cwd(), "scripts/sync-matrix-agent-skills.sh"), source], {
        env: { ...process.env, HOME: cliHome, MATRIX_HOME: matrixHome, HERMES_HOME: hermesHome,
          MATRIX_SKILL_TARGETS: "matrix,claude,codex,hermes" }, stdio: "pipe",
      });
      for (const target of targets) {
        expect(realpathSync(join(target, "my-builder"))).toBe(realpathSync(join(source, "app-builder")));
        expect(realpathSync(join(target, "my-motion"))).toBe(realpathSync(join(source, "animate")));
        expect(realpathSync(join(target, "previous-motion"))).toBe(realpathSync(join(previousSource, "animate")));
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(["default", "custom-home", "custom-root"])("preserves Agent skill collisions before invoking its installer (%s)", (location) => {
    const root = resolve(mkdirSync(join(tmpdir(), `matrix-agent-collisions-${location}-${Date.now()}`), { recursive: true }));
    const cliHome = join(root, "cli-home");
    const agentHome = location === "custom-home" ? join(root, "custom-agent-home") : join(cliHome, ".agent");
    const skillsRoot = location === "custom-root" ? join(root, "custom-skills") : join(agentHome, "skills");
    const fakeAgent = join(root, "agent");
    const logPath = join(root, "calls.log");
    try {
      writeSkill(skillsRoot, "animate", "animate");
      mkdirSync(join(skillsRoot, "matrix-app-builder"));
      execFileSync("ln", ["-s", join(root, "missing-owner-skill"), join(skillsRoot, "apple-design")]);
      writeFileSync(join(skillsRoot, "css-animations"), "owner file\n");
      writeFileSync(fakeAgent, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${logPath}"\n`);
      chmodSync(fakeAgent, 0o755);
      execFileSync("bash", [join(process.cwd(), "scripts/install-agent-matrix-skills.sh"), "Example/remote-repo"], {
        env: { ...process.env, AGENT_BIN: fakeAgent, HOME: cliHome,
          ...(location === "custom-home" ? { AGENT_HOME: agentHome } : {}),
          ...(location === "custom-root" ? { MATRIX_AGENT_SKILLS_ROOT: skillsRoot } : {}) }, stdio: "pipe",
      });
      const calls = readFileSync(logPath, "utf-8").split("\n");
      expect(calls.some((call) => call.endsWith("/animate"))).toBe(false);
      expect(calls.some((call) => call.endsWith("/app-builder"))).toBe(false);
      expect(calls.some((call) => call.endsWith("/apple-design"))).toBe(false);
      expect(calls.some((call) => call.endsWith("/css-animations"))).toBe(false);
      expect(calls.some((call) => call.endsWith("/integrations"))).toBe(true);
      expect(readFileSync(join(skillsRoot, "animate", "SKILL.md"), "utf-8")).toContain("animate test skill");
      expect(lstatSync(join(skillsRoot, "apple-design")).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(skillsRoot, "css-animations"), "utf-8")).toBe("owner file\n");
    } finally { rmSync(root, { recursive: true, force: true }); }
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
          HOME: join(root, "cli-home"),
        },
        stdio: "pipe",
      });

      expect(existsSync(logPath)).toBe(false);
      for (const skillDir of ["app-builder", "app-ui-patterns", "landing-design"]) {
        const target = join(root, "cli-home", ".agent", "skills", `matrix-${skillDir}`);
        expect(realpathSync(target)).toBe(realpathSync(join(source, skillDir)));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves remote Hermes destination collisions before invoking its installer", () => {
    const root = resolve(mkdirSync(join(tmpdir(), `matrix-hermes-remote-${Date.now()}`), { recursive: true }));
    const hermesHome = join(root, "hermes-home");
    const fakeHermes = join(root, "hermes");
    const logPath = join(root, "calls.log");
    try {
      writeSkill(join(hermesHome, "skills"), "animate", "animate");
      mkdirSync(join(hermesHome, "skills", "matrix-app-builder"));
      execFileSync("ln", ["-s", join(root, "missing-owner-skill"), join(hermesHome, "skills", "apple-design")]);
      writeFileSync(fakeHermes, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${logPath}"\n`);
      chmodSync(fakeHermes, 0o755);
      execFileSync("bash", [join(process.cwd(), "scripts/install-hermes-matrix-skills.sh"), "Example/remote-repo"], {
        env: { ...process.env, HERMES_BIN: fakeHermes, HERMES_HOME: hermesHome }, stdio: "pipe",
      });
      const calls = readFileSync(logPath, "utf-8").split("\n");
      expect(calls.some((call) => call.endsWith("/animate"))).toBe(false);
      expect(calls.some((call) => call.endsWith("/app-builder"))).toBe(false);
      expect(calls.some((call) => call.endsWith("/apple-design"))).toBe(false);
      expect(calls.some((call) => call.endsWith("/integrations"))).toBe(true);
      expect(calls.join("\n")).not.toContain("--force");
      expect(readFileSync(join(hermesHome, "skills", "animate", "SKILL.md"), "utf-8")).toContain("animate test skill");
      expect(lstatSync(join(hermesHome, "skills", "apple-design")).isSymbolicLink()).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
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
