import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildRemoteExtractScript,
  encodeClaudeProjectPath,
  isSafeHandoffPath,
  parseHandoffArgs,
  transcriptContainsCwd,
} from "../../.agents/skills/matrix-handoff/scripts/matrix-handoff.mjs";

const execFileAsync = promisify(execFile);
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("matrix handoff", () => {
  it("keeps source and agent instructions while excluding credentials and generated trees", () => {
    expect(isSafeHandoffPath("src/index.ts")).toBe(true);
    expect(isSafeHandoffPath(".claude/commands/review.md")).toBe(true);
    expect(isSafeHandoffPath(".codex/config.toml")).toBe(true);

    expect(isSafeHandoffPath(".env")).toBe(false);
    expect(isSafeHandoffPath("apps/web/.env.local")).toBe(false);
    expect(isSafeHandoffPath(".git/config")).toBe(false);
    expect(isSafeHandoffPath("node_modules/pkg/index.js")).toBe(false);
    expect(isSafeHandoffPath(".claude/settings.local.json")).toBe(false);
    expect(isSafeHandoffPath(".codex/auth.json")).toBe(false);
    expect(isSafeHandoffPath("keys/deploy_key.pem")).toBe(false);
    expect(isSafeHandoffPath("certs/client.p12")).toBe(false);
  });

  it("maps a repository path to Claude's project transcript directory", () => {
    expect(encodeClaudeProjectPath("/Users/example/dev/my repo")).toBe(
      "-Users-example-dev-my-repo",
    );
  });

  it("recognizes only transcript metadata for the active repository", () => {
    const jsonl = [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/work/repo" } }),
      JSON.stringify({ type: "message", text: "continue" }),
    ].join("\n");
    expect(transcriptContainsCwd(jsonl, "/work/repo")).toBe(true);
    expect(transcriptContainsCwd(jsonl, "/work/other")).toBe(false);
  });

  it("previews by default and requires a valid scope token for upload", () => {
    const approvalToken = `202608031900.${"a".repeat(64)}`;
    expect(parseHandoffArgs([])).toMatchObject({
      agent: "codex",
      includeHistory: true,
      confirmed: false,
    });
    expect(parseHandoffArgs(["--agent", "claude", "--approve", approvalToken, "--no-history"])).toMatchObject({
      agent: "claude",
      includeHistory: false,
      confirmed: true,
      approvalToken,
    });
    expect(() => parseHandoffArgs(["--yes"])).toThrow(/--approve/);
    expect(() => parseHandoffArgs(["--agent", "other"])).toThrow(/codex or claude/);
  });

  it("prints a scope approval token during preview", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "matrix-handoff-preview-test-"));
    tempDirectories.push(fixture);
    await execFileAsync("git", ["init", "-q"], { cwd: fixture });
    await writeFile(join(fixture, "safe.ts"), "export const safe = true;\n");
    await execFileAsync("git", ["add", "safe.ts"], { cwd: fixture });

    const script = resolve(".agents/skills/matrix-handoff/scripts/matrix-handoff.mjs");
    const { stdout } = await execFileAsync(
      process.execPath,
      [script, "--no-history", "--project-name", "Demo Project"],
      { cwd: fixture, timeout: 30_000 },
    );

    expect(stdout).toMatch(/Approval token: \d{12}\.[a-f0-9]{64}/);
    expect(stdout).toContain("Preview only");
  });

  it("rejects approval when the previewed workspace changes", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "matrix-handoff-scope-test-"));
    tempDirectories.push(fixture);
    await execFileAsync("git", ["init", "-q"], { cwd: fixture });
    await writeFile(join(fixture, "safe.ts"), "export const safe = true;\n");
    await execFileAsync("git", ["add", "safe.ts"], { cwd: fixture });

    const script = resolve(".agents/skills/matrix-handoff/scripts/matrix-handoff.mjs");
    const args = ["--no-history", "--project-name", "Demo Project"];
    const preview = await execFileAsync(process.execPath, [script, ...args], {
      cwd: fixture,
      timeout: 30_000,
    });
    const approvalToken = preview.stdout.match(/Approval token: (\d{12}\.[a-f0-9]{64})/)?.[1];
    expect(approvalToken).toBeTruthy();

    await writeFile(join(fixture, "safe.ts"), "export const safe = false;\n");

    await expect(execFileAsync(
      process.execPath,
      [script, ...args, "--approve", approvalToken!],
      {
        cwd: fixture,
        env: { ...process.env, MATRIX_CLI: join(fixture, "matrix-must-not-run") },
        timeout: 30_000,
      },
    )).rejects.toMatchObject({
      stderr: expect.stringMatching(/scope changed after preview/i),
    });
  });

  it("runs when installed through a symlinked global skill directory", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "matrix-handoff-symlink-test-"));
    tempDirectories.push(fixture);
    const installedSkill = join(fixture, "matrix-handoff");
    await symlink(resolve(".agents/skills/matrix-handoff"), installedSkill, "dir");

    const { stdout } = await execFileAsync(
      process.execPath,
      [join(installedSkill, "scripts", "matrix-handoff.mjs"), "--help"],
      { timeout: 30_000 },
    );

    expect(stdout).toContain("Usage: matrix-handoff [options]");
  });

  it("builds an extraction script from validated generated identifiers only", () => {
    const script = buildRemoteExtractScript({
      uploadId: "handoff-20260731-abc123",
      projectDir: "projects/matrix-os",
    });
    expect(script).toContain("Matrix project already exists");
    expect(script).toContain("Choose another --project-name");
    expect(script).toContain('cat "$upload_dir"/bundle.part-*');
    expect(script).toContain('tar -xzf - -C "$destination"');
    expect(() =>
      buildRemoteExtractScript({ uploadId: "../../bad", projectDir: "projects/good" }),
    ).toThrow(/safe handoff identifier/);
  });

  it("packages, uploads, extracts, and starts a detached remote agent session", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "matrix-handoff-test-"));
    tempDirectories.push(fixture);
    await execFileAsync("git", ["init", "-q"], { cwd: fixture });
    await writeFile(join(fixture, "safe.ts"), "export const safe = true;\n");
    await writeFile(join(fixture, ".env"), "DO_NOT_UPLOAD=secret\n");
    await execFileAsync("git", ["add", "safe.ts", ".env"], { cwd: fixture });

    const logPath = join(fixture, "matrix-calls.jsonl");
    const fakeMatrix = join(fixture, "fake-matrix.mjs");
    await writeFile(
      fakeMatrix,
      `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(process.env.MATRIX_CALL_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
`,
    );
    await chmod(fakeMatrix, 0o700);

    const script = resolve(".agents/skills/matrix-handoff/scripts/matrix-handoff.mjs");
    const commonArgs = ["--no-history", "--project-name", "Demo Project"];
    const preview = await execFileAsync(
      process.execPath,
      [script, ...commonArgs],
      { cwd: fixture, timeout: 30_000 },
    );
    const approvalToken = preview.stdout.match(/Approval token: (\d{12}\.[a-f0-9]{64})/)?.[1];
    expect(approvalToken).toBeTruthy();

    const { stdout } = await execFileAsync(
      process.execPath,
      [script, ...commonArgs, "--approve", approvalToken!],
      {
        cwd: fixture,
        env: { ...process.env, MATRIX_CLI: fakeMatrix, MATRIX_CALL_LOG: logPath },
        timeout: 30_000,
      },
    );

    const calls = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(calls.some((args) => args[0] === "upload")).toBe(true);
    expect(calls.some((args) =>
      args[0] === "run" && args.some((arg: unknown) => typeof arg === "string" && arg.includes("tar -xzf - -C")),
    )).toBe(true);
    expect(calls.some((args) => args[0] === "shell" && args[1] === "new")).toBe(true);
    expect(stdout).toContain("Handoff ready.");
    expect(stdout).toContain("~/projects/demo-project");
    expect(stdout).not.toContain("demo-project-handoff-");
  });
});
