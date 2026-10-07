import { execSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseReleaseProvenance } from "../../scripts/release-provenance.mjs";

const version = "v2026.09.28-pr1907-1-1-abcdef0";
const bash = execSync("command -v bash", { encoding: "utf8" }).trim();
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "matrix-release-provenance-"));
  directories.push(directory);
  return directory;
}

async function distDir(): Promise<string> {
  const directory = await scratch();
  await writeFile(join(directory, "matrix-host-bundle.tar.gz"), "bundle-bytes");
  await writeFile(join(directory, "incremental-manifest.json"), JSON.stringify({ requiresFullBundle: true, files: [] }));
  await writeFile(join(directory, "manifest.json"), JSON.stringify({
    gitCommit: "abcdef0123456789abcdef0123456789abcdef01",
    gitRef: "feature",
    buildTime: "2026-09-28T00:00:00Z",
  }));
  return directory;
}

function registrationBody(output: string, marker: string): Record<string, unknown> {
  const index = output.indexOf(marker);
  if (index === -1) throw new Error(`no registration body in output:\n${output}`);
  return JSON.parse(output.slice(index + marker.length).trim()) as Record<string, unknown>;
}

const provenanceArgs = ["--channel", "none", "--dry-run", "--source-pr", "1907", "--source-author", "octo-dev"];
const publishEnv = (dist: string, path: string) => ({
  PATH: path,
  HOME: process.env.HOME ?? "/tmp",
  HOST_BUNDLE_DIST_DIR: dist,
  AWS_ACCESS_KEY_ID: "test-access-key",
  AWS_SECRET_ACCESS_KEY: "test-secret-key",
  R2_ENDPOINT: "https://r2.test",
});

describe("release PR provenance", () => {
  it("accepts a PR number and GitHub login, and nothing when neither flag is given", () => {
    expect(parseReleaseProvenance({ sourcePr: "1907", sourceAuthor: "octo-dev" }))
      .toEqual({ sourcePr: 1907, sourceAuthor: "octo-dev" });
    expect(parseReleaseProvenance({})).toEqual({});
  });

  it.each([
    [{ sourcePr: "" }],
    [{ sourcePr: "0" }],
    [{ sourcePr: "1907abc" }],
    [{ sourcePr: "1000000000" }],
    [{ sourceAuthor: "" }],
    [{ sourceAuthor: "not a login" }],
    [{ sourceAuthor: "x".repeat(40) }],
  ])("rejects %j", (input) => {
    expect(() => parseReleaseProvenance(input)).toThrow(/source/);
  });

  it.each([
    [["--source-pr", "abc"], "--source-pr"],
    [["--source-pr"], "--source-pr"],
    [["--source-author"], "--source-author"],
  ])("publish-release.sh refuses %j before touching any bundle", (flags, message) => {
    const result = spawnSync(bash, ["scripts/publish-release.sh", version, ...flags], {
      encoding: "utf8",
      env: { ...process.env, HOST_BUNDLE_DIST_DIR: "/nonexistent" },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });

  it.each([["--source-pr"], ["--source-author"]])("publish-release-r2.mjs refuses a trailing %s without a value", (flag) => {
    const result = spawnSync(process.execPath, ["scripts/publish-release-r2.mjs", version, "--channel", "none", flag], {
      encoding: "utf8",
      env: { ...process.env, HOST_BUNDLE_DIST_DIR: "/nonexistent" },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(flag);
  });

  it("registers provenance through the aws publisher path", async () => {
    const dist = await distDir();
    const bin = await scratch();
    await writeFile(join(bin, "aws"), "#!/bin/sh\nexit 0\n");
    await chmod(join(bin, "aws"), 0o755);
    const result = spawnSync(bash, ["scripts/publish-release.sh", version, ...provenanceArgs], {
      encoding: "utf8",
      env: publishEnv(dist, `${bin}:${process.env.PATH}`),
    });
    expect(result.status, result.stderr).toBe(0);
    const body = registrationBody(result.stdout, "Would register release in platform DB:");
    expect(body).toMatchObject({ version, sourcePr: 1907, sourceAuthor: "octo-dev" });
    expect(body).not.toHaveProperty("channel");
  });

  it("forwards provenance to the Node publisher when aws is missing", async () => {
    const dist = await distDir();
    const bin = await scratch();
    await mkdir(bin, { recursive: true });
    await symlink(execSync("command -v dirname", { encoding: "utf8" }).trim(), join(bin, "dirname"));
    await symlink(process.execPath, join(bin, "node"));
    const result = spawnSync(bash, ["scripts/publish-release.sh", version, ...provenanceArgs], {
      encoding: "utf8",
      env: publishEnv(dist, bin),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("aws CLI not found");
    const body = registrationBody(result.stdout, "Would register release:");
    expect(body).toMatchObject({ version, sourcePr: 1907, sourceAuthor: "octo-dev" });
  });

  it("registers nothing extra without the flags", async () => {
    const dist = await distDir();
    const result = spawnSync(process.execPath, ["scripts/publish-release-r2.mjs", version, "--channel", "none", "--dry-run"], {
      encoding: "utf8",
      env: publishEnv(dist, process.env.PATH ?? ""),
    });
    expect(result.status, result.stderr).toBe(0);
    const body = registrationBody(result.stdout, "Would register release:");
    expect(body).not.toHaveProperty("sourcePr");
    expect(body).not.toHaveProperty("sourceAuthor");
  });
});
