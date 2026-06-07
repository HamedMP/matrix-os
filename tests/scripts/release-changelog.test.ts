import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildReleaseChangelog,
  humanizeCommitSubject,
} from "../../scripts/release-changelog.mjs";

describe("release changelog generation", () => {
  it("turns conventional commit subjects into reader-friendly notes", () => {
    expect(humanizeCommitSubject("fix(platform): sync Clerk users into platform db (#423)")).toBe(
      "Sync Clerk users into platform database.",
    );
    expect(humanizeCommitSubject("feat(cli): document package runner launch path")).toBe(
      "Document package runner launch path.",
    );
  });

  it("groups every included commit without showing hashes", () => {
    const changelog = buildReleaseChangelog([
      "feat(shell): add billing plan chooser",
      "fix(platform): route signup billing through auth shell",
      "chore(ci): refresh bundle release workflow",
    ]);

    expect(changelog).toContain("What's changed");
    expect(changelog).toContain("New");
    expect(changelog).toContain("- Add billing plan chooser.");
    expect(changelog).toContain("Fixed");
    expect(changelog).toContain("- Route signup billing through auth shell.");
    expect(changelog).toContain("Polish and reliability");
    expect(changelog).toContain("- Refresh bundle release workflow.");
    expect(changelog).not.toContain("feat(shell)");
    expect(changelog).not.toContain("abc123");
  });

  it("caps the no-base fallback so it cannot emit the whole repository history", () => {
    const repo = mkdtempSync(join(tmpdir(), "matrix-release-changelog-"));
    const gitHome = join(repo, ".git-home");
    mkdirSync(gitHome);
    const env = isolatedGitEnv(repo, gitHome);
    const script = join(process.cwd(), "scripts/release-changelog.mjs");

    try {
      runGit(repo, env, "init");
      runGit(repo, env, "config", "user.email", "ci@example.com");
      runGit(repo, env, "config", "user.name", "Matrix CI");

      for (let index = 1; index <= 105; index += 1) {
        writeFileSync(join(repo, "note.txt"), `${index}\n`);
        runGit(repo, env, "add", "note.txt");
        runGit(repo, env, "commit", "-m", `fix: fallback note ${String(index).padStart(3, "0")}`);
      }

      const result = spawnSync(process.execPath, [script, "--head", "HEAD"], {
        cwd: repo,
        env,
        encoding: "utf8",
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toContain("Fallback note 001.");
      expect(result.stdout).not.toContain("Fallback note 005.");
      expect(result.stdout).toContain("Fallback note 006.");
      expect(result.stdout).toContain("Fallback note 105.");
      expect(result.stdout.match(/^- /gm)).toHaveLength(100);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

function isolatedGitEnv(repo: string, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  env.HOME = home;
  env.XDG_CONFIG_HOME = join(home, ".config");
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = join(home, ".gitconfig");
  env.GIT_CEILING_DIRECTORIES = repo;
  return env;
}

function runGit(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  const result = spawnSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
  });
  expect(result.status, result.stderr || result.stdout).toBe(0);
}
