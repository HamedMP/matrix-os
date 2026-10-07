import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, realpathSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repo = resolve(__dirname, "../..");
const source = join(repo, "skills/matrix");
const shipped = readdirSync(source, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();

describe("shadcn and companion installation", () => {
  it.each(["agent", "hermes"] as const)("passes every shipped skill including shadcn through the %s installer", (harness) => {
    const fixture = mkdtempSync(join(tmpdir(), "matrix-shadcn-install-"));
    const executable = join(fixture, harness);
    const log = join(fixture, "install.log");
    try {
      writeFileSync(executable, '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$MATRIX_INSTALL_LOG"\n');
      chmodSync(executable, 0o755);
      // Both remote fallbacks use only the fake CLI, without fetching code.
      const installSource = "example/matrix-skills";
      execFileSync("bash", [join(repo, `scripts/install-${harness}-matrix-skills.sh`), installSource], {
        env: { ...process.env, HOME: fixture, HERMES_HOME: join(fixture, "hermes-home"),
          AGENT_BIN: executable, HERMES_BIN: executable, MATRIX_AGENT_SKILLS_ROOT: join(fixture, "agent-skills"), MATRIX_INSTALL_LOG: log },
        stdio: "pipe",
      });
      const entries = readFileSync(log, "utf8").trim().split("\n");
      expect(entries.map((entry) => entry.split("/").at(-1)).sort()).toEqual(shipped);
      expect(entries).toHaveLength(shipped.length);
      expect(entries.some((entry) => entry.split(" ").includes("--force"))).toBe(false);
      expect(entries.some((entry) => entry.endsWith("/shadcn"))).toBe(true);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
  it("syncs every shipped local skill into Agent without invoking its CLI", () => {
    const fixture = mkdtempSync(join(tmpdir(), "matrix-agent-local-pack-"));
    const destination = join(fixture, "agent-skills");
    try {
      execFileSync("bash", [join(repo, "scripts/install-agent-matrix-skills.sh"), source], {
        env: { ...process.env, HOME: fixture, AGENT_BIN: join(fixture, "absent-cli"), MATRIX_AGENT_SKILLS_ROOT: destination }, stdio: "pipe",
      });
      expect(readdirSync(destination)).toHaveLength(shipped.length);
      for (const directory of shipped) {
        const name = readFileSync(join(source, directory, "SKILL.md"), "utf8").match(/^name:\s*(.+)$/m)?.[1].trim();
        expect(name).toBeTruthy();
        expect(realpathSync(join(destination, name!))).toBe(realpathSync(join(source, directory)));
      }
      expect(existsSync(join(fixture, ".agents"))).toBe(false);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });
  it.each([
    ["agent", "file"], ["agent", "directory"], ["agent", "dangling-link"],
    ["hermes", "file"], ["hermes", "directory"], ["hermes", "dangling-link"],
  ] as const)("preserves an existing %s skill %s for every canonical shipped name", (harness, existing) => {
    const fixture = mkdtempSync(join(tmpdir(), "matrix-shadcn-collision-"));
    const executable = join(fixture, harness);
    const log = join(fixture, "install.log");
    const destinationRoot = join(fixture, "destination", "skills");
    try {
      mkdirSync(destinationRoot, { recursive: true });
      writeFileSync(log, "");
      writeFileSync(executable, '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$MATRIX_INSTALL_LOG"\n');
      chmodSync(executable, 0o755);
      const canonicalNames = shipped.map((directory) => {
        const metadata = readFileSync(join(source, directory, "SKILL.md"), "utf8");
        const name = metadata.match(/^name:\s*(.+)$/m)?.[1].trim();
        if (!name) throw new Error(`Missing skill name: ${directory}`);
        return name;
      });
      for (const name of canonicalNames) {
        const destination = join(destinationRoot, name);
        if (existing === "directory") mkdirSync(destination);
        else if (existing === "dangling-link") symlinkSync(join(fixture, "missing-target"), destination);
        else writeFileSync(destination, "owner-managed");
      }
      execFileSync("bash", [join(repo, `scripts/install-${harness}-matrix-skills.sh`), "example/matrix-skills"], {
        env: { ...process.env, HOME: fixture, HERMES_HOME: join(fixture, "destination"),
          AGENT_BIN: executable, HERMES_BIN: executable, MATRIX_AGENT_SKILLS_ROOT: destinationRoot, MATRIX_INSTALL_LOG: log },
        stdio: "pipe",
      });
      expect(readFileSync(log, "utf8")).toBe("");
      expect(readdirSync(destinationRoot).sort()).toEqual(canonicalNames.sort());
      if (existing === "file") {
        for (const name of canonicalNames) expect(readFileSync(join(destinationRoot, name), "utf8")).toBe("owner-managed");
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

});
