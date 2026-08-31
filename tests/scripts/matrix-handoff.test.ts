import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildRemoteDestinationCheckScript,
  buildRemoteExtractScript,
  createHandoffUploadId,
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
    const destinationCheck = buildRemoteDestinationCheckScript({
      projectDir: "projects/matrix-os",
    });
    expect(destinationCheck).toContain('destination="$HOME/projects/matrix-os"');
    expect(destinationCheck).toContain("Choose another --project-name");

    const script = buildRemoteExtractScript({
      uploadId: "handoff-20260731-abc123",
      projectDir: "projects/matrix-os",
    });
    expect(script).toContain("Matrix project already exists");
    expect(script).toContain("Choose another --project-name");
    expect(script).toContain('cat "$upload_dir"/bundle.part-*');
    expect(script).toContain('tar -xzf - -C "$staging"');
    expect(script).toContain('mv -T -n "$staging" "$destination"');
    expect(script).toContain("trap cleanup_upload EXIT");
    expect(script).toContain("trap abort_handoff HUP INT TERM");
    expect(script).not.toContain('mkdir -p "$destination"');
    expect(script).not.toContain('rm -rf "$destination"');
    expect(() =>
      buildRemoteDestinationCheckScript({ projectDir: "../../bad" }),
    ).toThrow(/safe handoff identifier/);
    expect(() =>
      buildRemoteExtractScript({ uploadId: "../../bad", projectDir: "projects/good" }),
    ).toThrow(/safe handoff identifier/);
  });

  it.skipIf(process.platform !== "linux")("atomically reserves a same-name destination during concurrent extraction", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "matrix-handoff-race-test-"));
    tempDirectories.push(fixture);
    const sourceA = join(fixture, "source-a");
    const sourceB = join(fixture, "source-b");
    const approval = {
      stamp: "202608311945",
      scopeDigest: "a".repeat(64),
    };
    const uploadIdA = createHandoffUploadId(approval);
    const uploadIdB = createHandoffUploadId(approval);
    const uploadA = join(fixture, ".matrix-handoff", uploadIdA);
    const uploadB = join(fixture, ".matrix-handoff", uploadIdB);
    expect(uploadIdA).not.toBe(uploadIdB);
    await Promise.all([mkdir(sourceA), mkdir(sourceB), mkdir(uploadA, { recursive: true }), mkdir(uploadB, { recursive: true })]);
    await Promise.all([
      writeFile(join(sourceA, "winner-a.txt"), "a\n"),
      writeFile(join(sourceB, "winner-b.txt"), "b\n"),
    ]);
    await Promise.all([
      execFileAsync("tar", ["-czf", join(uploadA, "bundle.part-000000"), "-C", sourceA, "."]),
      execFileAsync("tar", ["-czf", join(uploadB, "bundle.part-000000"), "-C", sourceB, "."]),
    ]);

    const projectDir = "projects/shared-name";
    const results = await Promise.allSettled([
      execFileAsync("sh", ["-c", buildRemoteExtractScript({ uploadId: uploadIdA, projectDir })], {
        env: { ...process.env, HOME: fixture },
      }),
      execFileAsync("sh", ["-c", buildRemoteExtractScript({ uploadId: uploadIdB, projectDir })], {
        env: { ...process.env, HOME: fixture },
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const destination = join(fixture, projectDir);
    const markers = await Promise.all([
      readFile(join(destination, "winner-a.txt"), "utf8").then(() => "a", () => null),
      readFile(join(destination, "winner-b.txt"), "utf8").then(() => "b", () => null),
    ]);
    expect(markers.filter(Boolean)).toHaveLength(1);
  });

  it("uses a unique upload namespace for identical approved scopes", () => {
    const approval = {
      stamp: "202608311945",
      scopeDigest: "b".repeat(64),
    };

    const first = createHandoffUploadId(approval);
    const second = createHandoffUploadId(approval);

    expect(first).toMatch(/^handoff-202608311945-b{12}-[a-f0-9]{32}$/);
    expect(second).not.toBe(first);
  });

  it("removes its reserved destination when archive extraction fails", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "matrix-handoff-extract-failure-test-"));
    tempDirectories.push(fixture);
    const uploadDir = join(fixture, ".matrix-handoff", "broken-upload");
    await mkdir(uploadDir, { recursive: true });
    await writeFile(join(uploadDir, "bundle.part-000000"), "not a gzip archive\n");
    const projectDir = "projects/retryable-name";

    await expect(execFileAsync(
      "sh",
      ["-c", buildRemoteExtractScript({ uploadId: "broken-upload", projectDir })],
      { env: { ...process.env, HOME: fixture } },
    )).rejects.toBeTruthy();

    await expect(stat(join(fixture, projectDir))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(uploadDir)).rejects.toMatchObject({ code: "ENOENT" });
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
    const destinationCheckIndex = calls.findIndex((args) =>
      args[0] === "run" && args.some((arg: unknown) => typeof arg === "string" && arg.includes("Matrix project already exists")),
    );
    const uploadIndex = calls.findIndex((args) => args[0] === "upload");
    expect(destinationCheckIndex).toBeGreaterThanOrEqual(0);
    expect(uploadIndex).toBeGreaterThan(destinationCheckIndex);
    expect(calls.some((args) =>
      args[0] === "run" && args.some((arg: unknown) => typeof arg === "string" && arg.includes("tar -xzf - -C")),
    )).toBe(true);
    expect(calls.some((args) => args[0] === "shell" && args[1] === "new")).toBe(true);
    expect(stdout).toContain("Handoff ready.");
    expect(stdout).toContain("~/projects/demo-project");
    expect(stdout).not.toContain("demo-project-handoff-");
  });

  it("stops before upload when the Matrix project destination already exists", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "matrix-handoff-collision-test-"));
    tempDirectories.push(fixture);
    await execFileAsync("git", ["init", "-q"], { cwd: fixture });
    await writeFile(join(fixture, "safe.ts"), "export const safe = true;\n");
    await execFileAsync("git", ["add", "safe.ts"], { cwd: fixture });

    const logPath = join(fixture, "matrix-calls.jsonl");
    const fakeMatrix = join(fixture, "fake-matrix.mjs");
    await writeFile(
      fakeMatrix,
      `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.MATRIX_CALL_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "run" && args.some((arg) => arg.includes("Matrix project already exists"))) {
  console.error("Matrix project already exists");
  process.exit(73);
}
`,
    );
    await chmod(fakeMatrix, 0o700);

    const script = resolve(".agents/skills/matrix-handoff/scripts/matrix-handoff.mjs");
    const commonArgs = ["--no-history", "--project-name", "Demo Project"];
    const preview = await execFileAsync(process.execPath, [script, ...commonArgs], {
      cwd: fixture,
      timeout: 30_000,
    });
    const approvalToken = preview.stdout.match(/Approval token: (\d{12}\.[a-f0-9]{64})/)?.[1];
    expect(approvalToken).toBeTruthy();

    await expect(execFileAsync(
      process.execPath,
      [script, ...commonArgs, "--approve", approvalToken!],
      {
        cwd: fixture,
        env: { ...process.env, MATRIX_CLI: fakeMatrix, MATRIX_CALL_LOG: logPath },
        timeout: 30_000,
      },
    )).rejects.toMatchObject({
      stderr: expect.stringContaining("Matrix project already exists"),
    });

    const calls = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(calls.some((args) => args[0] === "run")).toBe(true);
    expect(calls.some((args) => args[0] === "upload")).toBe(false);
  });
});
