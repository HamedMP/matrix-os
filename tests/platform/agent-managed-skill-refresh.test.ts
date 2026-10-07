import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const install = resolve(__dirname, "../../scripts/install-agent-matrix-skills.sh");
const sync = resolve(__dirname, "../../scripts/sync-matrix-agent-skills.sh");

function skill(root: string, name: string, body: string) {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "SKILL.md"), `---\nname: ${name}\nauthor: Matrix OS\ndescription: Test skill\n---\n${body}\n`);
  writeFileSync(join(path, ".matrix-os-managed"), "");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "matrix-agent-refresh-"));
  const oldSource = join(root, "old", "skills", "matrix");
  const nextSource = join(root, "next", "skills", "matrix");
  for (const source of [oldSource, nextSource]) {
    for (const name of ["animate", "apple-design", "css-animations", "animation-accessibility"]) {
      skill(source, name, source === oldSource ? "Old instructions" : "New instructions");
    }
    // The local installer accepts a directory named app-builder for direct roots.
    mkdirSync(join(source, "app-builder"), { recursive: true });
    writeFileSync(join(source, "app-builder", "SKILL.md"), "---\nname: matrix-app-builder\ndescription: Test\n---\nBuilder\n");
    writeFileSync(join(source, "app-builder", ".matrix-os-managed"), "");
  }
  const cliHome = join(root, "owner-home");
  const env = { ...process.env, HOME: cliHome, AGENT_BIN: join(root, "missing-agent-cli"), MATRIX_HOME: join(root, "matrix-home") };
  return { root, oldSource, nextSource, cliHome, env };
}

function run(script: string, source: string, env: NodeJS.ProcessEnv) {
  return execFileSync("bash", [script, source], { env, encoding: "utf8", stdio: "pipe" });
}

describe("managed local Agent skill refresh", () => {
  it.each(["default", "custom-home", "custom-root"])("refreshes release-owned links and copies without an Agent CLI (%s)", (location) => {
    const f = fixture();
    const agentHome = location === "custom-home" ? join(f.root, "agent-home") : join(f.cliHome, ".agent");
    const skillsRoot = location === "custom-root" ? join(f.root, "explicit-skills") : join(agentHome, "skills");
    const env = { ...f.env, ...(location === "custom-home" ? { AGENT_HOME: agentHome } : {}), ...(location === "custom-root" ? { MATRIX_AGENT_SKILLS_ROOT: skillsRoot } : {}) };
    try {
      run(install, join(f.root, "old"), env);
      expect(realpathSync(join(skillsRoot, "animate"))).toBe(realpathSync(join(f.oldSource, "animate")));
      rmSync(join(skillsRoot, "animate"));
      skill(skillsRoot, "animate", "Old managed copy");
      skill(skillsRoot, "obsolete-managed", "Obsolete instructions");
      run(install, f.nextSource, env);
      expect(readFileSync(join(skillsRoot, "animate", "SKILL.md"), "utf8")).toContain("New instructions");
      expect(realpathSync(join(skillsRoot, "css-animations"))).toBe(realpathSync(join(f.nextSource, "css-animations")));
      expect(existsSync(join(skillsRoot, "obsolete-managed"))).toBe(false);
      expect(existsSync(join(f.cliHome, ".claude"))).toBe(false);
      expect(existsSync(join(f.env.MATRIX_HOME, ".agents"))).toBe(false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("preserves owner directories, files, dangling links, and aliases to both release sources", () => {
    const f = fixture();
    const skillsRoot = join(f.root, "custom-skills");
    const env = { ...f.env, MATRIX_AGENT_SKILLS_ROOT: skillsRoot };
    try {
      mkdirSync(join(skillsRoot, "animate"), { recursive: true });
      writeFileSync(join(skillsRoot, "animate", "SKILL.md"), "Owner customization\n");
      writeFileSync(join(skillsRoot, "apple-design"), "Owner file\n");
      symlinkSync(join(f.root, "missing-owner"), join(skillsRoot, "css-animations"));
      symlinkSync(join(f.oldSource, "animation-accessibility"), join(skillsRoot, "my-old-motion"));
      symlinkSync(join(f.nextSource, "animation-accessibility"), join(skillsRoot, "my-current-motion"));
      run(install, f.nextSource, env);
      expect(readFileSync(join(skillsRoot, "animate", "SKILL.md"), "utf8")).toBe("Owner customization\n");
      expect(readFileSync(join(skillsRoot, "apple-design"), "utf8")).toBe("Owner file\n");
      expect(lstatSync(join(skillsRoot, "css-animations")).isSymbolicLink()).toBe(true);
      expect(realpathSync(join(skillsRoot, "my-old-motion"))).toBe(realpathSync(join(f.oldSource, "animation-accessibility")));
      expect(realpathSync(join(skillsRoot, "my-current-motion"))).toBe(realpathSync(join(f.nextSource, "animation-accessibility")));
      expect(realpathSync(join(skillsRoot, "animation-accessibility"))).toBe(realpathSync(join(f.nextSource, "animation-accessibility")));
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it.each(["empty", "invalid-metadata"])("rejects an invalid local source before cleanup or CLI invocation (%s)", (kind) => {
    const f = fixture();
    const invalidSource = join(f.root, "invalid", "skills", "matrix");
    const destination = join(f.root, "agent-skills");
    const cli = join(f.root, "fake-agent");
    const log = join(f.root, "cli.log");
    try {
      mkdirSync(invalidSource, { recursive: true });
      if (kind === "invalid-metadata") skill(invalidSource, "app-builder", "Invalid builder");
      skill(destination, "animate", "Previous managed instructions");
      writeFileSync(cli, '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$MATRIX_INSTALL_LOG"\n');
      chmodSync(cli, 0o755);
      expect(() => run(install, join(f.root, "invalid"), { ...f.env, AGENT_BIN: cli, MATRIX_AGENT_SKILLS_ROOT: destination, MATRIX_INSTALL_LOG: log })).toThrow();
      expect(() => run(sync, invalidSource, { ...f.env, MATRIX_SKILL_TARGETS: "agent", MATRIX_AGENT_SKILLS_ROOT: destination })).toThrow();
      expect(readFileSync(join(destination, "animate", "SKILL.md"), "utf8")).toContain("Previous managed instructions");
      expect(existsSync(log)).toBe(false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it.each(["same", "source-ancestor", "target-ancestor", "resolved-link", "missing-dotdot", "missing-dotdot-link", "missing-dotdot-link-parent", "resolved-link-parent"])("rejects overlapping source and Agent destination before modifying either (%s)", (overlap) => {
    const f = fixture();
    try {
      let destination = overlap === "missing-dotdot" ? `${f.nextSource}/not-created/..`
        : overlap === "source-ancestor" ? join(f.nextSource, "destination")
        : overlap === "target-ancestor" ? join(f.root, "next") : f.nextSource;
      if (overlap === "resolved-link") {
        destination = join(f.root, "linked-destination");
        symlinkSync(f.nextSource, destination);
      }
      if (overlap === "resolved-link-parent") {
        const outside = join(f.root, "outside");
        mkdirSync(outside);
        symlinkSync(f.nextSource, join(outside, "link"));
        destination = `${outside}/link/..`;
      }
      if (overlap.startsWith("missing-dotdot-link")) {
        const outside = join(f.root, "outside");
        mkdirSync(outside);
        symlinkSync(f.nextSource, join(outside, "link"));
        destination = `${outside}/missing/../link${overlap.endsWith("-parent") ? "/.." : ""}`;
      }
      expect(() => run(install, f.nextSource, { ...f.env, MATRIX_AGENT_SKILLS_ROOT: destination })).toThrow();
      expect(readFileSync(join(f.nextSource, "animate", "SKILL.md"), "utf8")).toContain("New instructions");
      expect(() => run(sync, f.nextSource, { ...f.env, MATRIX_SKILL_TARGETS: "agent", MATRIX_AGENT_SKILLS_ROOT: destination })).toThrow();
      expect(readFileSync(join(f.nextSource, "animate", "SKILL.md"), "utf8")).toContain("New instructions");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it.each(["source", "destination"])("rejects newline-bearing %s paths before source files can be removed", (kind) => {
    const f = fixture();
    try {
      let source = f.nextSource;
      let destination: string;
      if (kind === "source") {
        source = join(f.root, "source\nwith-newline", "skills", "matrix");
        cpSync(f.nextSource, source, { recursive: true });
        destination = source;
      } else {
        const outside = join(f.root, "outside");
        mkdirSync(outside);
        symlinkSync(source, join(outside, "link"));
        destination = `${outside}/missing\nfolder/../link`;
      }
      expect(() => run(install, source, { ...f.env, MATRIX_AGENT_SKILLS_ROOT: destination })).toThrow();
      expect(readFileSync(join(source, "animate", "SKILL.md"), "utf8")).toContain("New instructions");
      expect(() => run(sync, source, { ...f.env, MATRIX_SKILL_TARGETS: "agent", MATRIX_AGENT_SKILLS_ROOT: destination })).toThrow();
      expect(readFileSync(join(source, "animate", "SKILL.md"), "utf8")).toContain("New instructions");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it.each(["source", "destination"])("rejects newline-bearing physical %s paths reached through an ordinary alias", (kind) => {
    const f = fixture();
    try {
      const destination = join(f.root, "agent-skills");
      const physical = join(f.root, "physical\n");
      const alias = join(f.root, "ordinary-alias");
      let source = f.nextSource;
      let target = destination;
      if (kind === "source") {
        cpSync(f.nextSource, physical, { recursive: true });
        symlinkSync(physical, alias);
        source = alias;
      } else {
        mkdirSync(physical);
        symlinkSync(physical, alias);
        target = alias;
      }
      skill(kind === "source" ? destination : physical, "animate", "Previous managed instructions");
      expect(() => run(install, source, { ...f.env, MATRIX_AGENT_SKILLS_ROOT: target })).toThrow();
      expect(readFileSync(join(target, "animate", "SKILL.md"), "utf8")).toContain("Previous managed instructions");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("rejects the filesystem root as an ancestor without invoking cleanup", () => {
    const f = fixture();
    try {
      const script = readFileSync(sync, "utf8");
      const helpers = script.slice(script.indexOf("canonical_destination()"), script.indexOf("# Preflight every selected root"));
      expect(() => execFileSync("bash", ["-c", `${helpers}\nvalidate_destination /`], {
        env: { ...f.env, MATRIX_SKILLS_SOURCE: realpathSync(f.nextSource) }, stdio: "pipe",
      })).toThrow();
      expect(readFileSync(join(f.nextSource, "animate", "SKILL.md"), "utf8")).toContain("New instructions");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("preflights all selected roots before changing a valid Agent destination", () => {
    const f = fixture();
    const destination = join(f.root, "agent-skills");
    try {
      skill(destination, "animate", "Previous managed instructions");
      expect(() => run(sync, f.nextSource, { ...f.env, MATRIX_SKILL_TARGETS: "agent,matrix", MATRIX_AGENT_SKILLS_ROOT: destination, MATRIX_HOME: f.nextSource })).toThrow();
      expect(readFileSync(join(destination, "animate", "SKILL.md"), "utf8")).toContain("Previous managed instructions");
      expect(existsSync(join(f.nextSource, ".agents"))).toBe(false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("supports an explicit Agent-only sync target without touching other harness roots", () => {
    const f = fixture();
    const skillsRoot = join(f.root, "explicit-skills");
    try {
      run(sync, f.nextSource, { ...f.env, MATRIX_SKILL_TARGETS: "agent", MATRIX_AGENT_SKILLS_ROOT: skillsRoot });
      expect(realpathSync(join(skillsRoot, "animate"))).toBe(realpathSync(join(f.nextSource, "animate")));
      expect(existsSync(join(f.cliHome, ".agents"))).toBe(false);
      expect(existsSync(join(f.env.MATRIX_HOME, ".agents"))).toBe(false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});
