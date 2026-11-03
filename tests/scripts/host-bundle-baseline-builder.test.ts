import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";

const repo = process.cwd();
const fixtures: string[] = [];
afterEach(() => {
  for (const dir of fixtures.splice(0)) {
    const receipt = join(dir, "source-path");
    if (existsSync(receipt)) {
      const owned = dirname(readFileSync(receipt, "utf8"));
      if (basename(owned).startsWith("matrix-host-builder-")) rmSync(owned, { recursive: true, force: true });
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture(docker: string) {
  const root = mkdtempSync(join(tmpdir(), "host-baseline-builder-")); fixtures.push(root);
  mkdirSync(join(root, "scripts")); mkdirSync(join(root, "bin")); mkdirSync(join(root, "home"));
  for (const file of ["build-host-bundle.sh", "host-bundle-baseline-builder.mjs", "host-bundle-builder.Dockerfile"]) {
    if (existsSync(join(repo, "scripts", file))) cpSync(join(repo, "scripts", file), join(root, "scripts", file));
  }
  writeFileSync(join(root, ".env.private"), "PRIVATE_FIXTURE_VALUE=do-not-transfer\n");
  mkdirSync(join(root, "packages/fixture/node_modules"), { recursive: true });
  mkdirSync(join(root, "packages/fixture/dist"));
  writeFileSync(join(root, "packages/fixture/node_modules/prebuilt.node"), "tracked-host-native");
  writeFileSync(join(root, "packages/fixture/node_modules/prebuilt.js"), "tracked-host-dependency");
  writeFileSync(join(root, "packages/fixture/dist/prebuilt.js"), "tracked-compiled-output");
  writeFileSync(join(root, "packages/fixture/.env.private"), "NESTED_PRIVATE_FIXTURE_VALUE=do-not-transfer\n");
  writeFileSync(join(root, "bin/docker"), `#!${process.execPath}\n${docker}\n`, { mode: 0o755 });
  writeFileSync(join(root, "bin/pnpm"), `#!/bin/sh\necho host-install > '${join(root, "host-install")}'\nexit 91\n`, { mode: 0o755 });
  symlinkSync(process.execPath, join(root, "bin/node"));
  const git = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0); return result.stdout.trim();
  };
  git(["init", "-q"]); git(["add", "scripts", ".env.private", "packages"]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
  const sha = git(["rev-parse", "HEAD"]);
  const env = { PATH: join(root, "bin") + delimiter + process.env.PATH, HOME: join(root, "home"),
    HOST_BUNDLE_VERSION: "v2026.11.03-fixture", HOST_BUNDLE_CHANNEL: "none", MATRIX_BUILD_SHA: sha,
    MATRIX_BUILD_REF: "fixture", NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_fixture", FIXTURE_ROOT: root };
  return { root, env, git, helper: (extra = {}, expression?: string) => spawnSync(process.execPath,
    expression ? ["--input-type=module", "-e", expression] : ["scripts/host-bundle-baseline-builder.mjs"],
    { cwd: root, env: { ...env, ...extra }, encoding: "utf8", timeout: 20_000 }),
    run: (extra = {}) => spawnSync("bash", ["scripts/build-host-bundle.sh"], {
    cwd: root, env: { ...env, ...extra }, encoding: "utf8", timeout: 20_000,
  }) };
}

it("routes the real unsupported-host entry before deleting staging or installing on the host", () => {
  const f = fixture("require('node:fs').writeFileSync(process.env.FIXTURE_ROOT + '/docker-called', 'yes'); process.exit(83);");
  const stage = join(f.root, "dist/host-bundle/stage"); mkdirSync(stage, { recursive: true });
  writeFileSync(join(stage, "canary"), "retain-on-builder-failure");
  const supported = process.platform === "linux" && process.arch === "x64" && process.report.getReport().header.glibcVersionRuntime === "2.39";
  const result = f.run();
  expect(result.status, result.stderr).toBe(supported ? 91 : 83);
  expect(existsSync(join(f.root, "docker-called"))).toBe(!supported);
  expect(existsSync(join(f.root, "host-install"))).toBe(supported);
  expect(existsSync(join(stage, "canary"))).toBe(!supported);
});

function dockerFixture(options: { mismatchedMetadata?: boolean; mismatchedRef?: boolean; symlinkArtifact?: boolean; symlinkDirectory?: boolean; zeroObject?: boolean; hang?: boolean; cleanupFailure?: boolean } = {}) {
  return fixture(`
const fs = require('node:fs'), path = require('node:path');
const root = process.env.FIXTURE_ROOT, args = process.argv.slice(2), options = ${JSON.stringify(options)};
fs.appendFileSync(path.join(root, 'docker-log'), JSON.stringify(args) + '\\n');
if (args[0] === 'build') {
  const context = args.at(-1);
  fs.writeFileSync(path.join(root, 'context-files'), JSON.stringify(fs.readdirSync(context)));
  fs.writeFileSync(args[args.indexOf('--iidfile') + 1], 'sha256:' + 'a'.repeat(64));
} else if (args[0] === 'create') {
  const source = args[args.indexOf('--mount') + 1].split(',src=')[1].split(',dst=')[0];
  fs.writeFileSync(path.join(root, 'source-path'), source);
  fs.writeFileSync(path.join(root, 'source-files'), JSON.stringify(fs.readdirSync(source)));
  const mounts = args.flatMap((arg, index) => arg === '--mount' ? [Object.fromEntries(args[index + 1].split(',').map(pair => pair.split('=')))] : []);
  const forwarded = Object.fromEntries(args.flatMap((arg, index) => arg === '--env' ? [args[index + 1].split(/=(.*)/s).slice(0, 2)] : []));
  const scratchMount = mounts.find(mount => forwarded.TMPDIR === mount.dst || forwarded.TMPDIR.startsWith(mount.dst + '/'));
  const tmp = path.join(scratchMount.src, path.relative(scratchMount.dst, forwarded.TMPDIR));
  fs.writeFileSync(path.join(root, 'tmp-state'), JSON.stringify(fs.existsSync(tmp) ? { mode: fs.statSync(tmp).mode & 511, entries: fs.readdirSync(tmp) } : null));
  const sentinel = path.join(source, 'node_modules/matrix-artifact-build-only/index.js');
  fs.mkdirSync(path.dirname(sentinel), { recursive: true }); fs.writeFileSync(sentinel, 'module.exports = "BUILD_STORE_ONLY";');
  let buildStoreReachable = false;
  try { require('node:module').createRequire(path.join(tmp, 'extracted/app/package.json')).resolve('matrix-artifact-build-only'); buildStoreReachable = true; }
  catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  fs.writeFileSync(path.join(root, 'scratch-resolution'), JSON.stringify({ buildStoreReachable, tmp, source, target: scratchMount.dst }));
  fs.writeFileSync(path.join(root, 'excluded-paths'), JSON.stringify(['packages/fixture/node_modules', 'packages/fixture/dist', 'packages/fixture/.env.private'].map(name => fs.existsSync(path.join(source, name)))));
  fs.writeFileSync(path.join(root, 'create-args'), JSON.stringify(args));
} else if (args[0] === 'start') {
  if (options.hang) { setInterval(() => {}, 1000); return; }
  const source = fs.readFileSync(path.join(root, 'source-path'), 'utf8');
  const created = JSON.parse(fs.readFileSync(path.join(root, 'create-args'), 'utf8'));
  const env = Object.fromEntries(created.flatMap((arg, index) => arg === '--env' ? [created[index + 1].split(/=(.*)/s).slice(0, 2)] : []));
  const output = path.join(source, 'dist/host-bundle'); fs.mkdirSync(path.join(output, 'objects/sha256'), { recursive: true });
  const metadata = { gitCommit: options.mismatchedMetadata ? 'b'.repeat(40) : env.MATRIX_BUILD_SHA, gitRef: options.mismatchedRef ? 'wrong-ref' : env.MATRIX_BUILD_REF, version: env.HOST_BUNDLE_VERSION, channel: env.HOST_BUNDLE_CHANNEL };
  for (const file of ['release.json', 'manifest.json']) fs.writeFileSync(path.join(output, file), JSON.stringify(metadata));
  fs.writeFileSync(path.join(output, 'matrix-host-bundle.tar.gz'), 'fixture-archive');
  fs.writeFileSync(path.join(output, 'matrix-host-bundle.tar.gz.sha256'), 'fixture-sha');
  fs.writeFileSync(path.join(output, 'incremental-manifest.json'), '{}');
  fs.writeFileSync(path.join(output, 'objects/sha256', 'c'.repeat(64)), 'fixture-object');
  if (options.zeroObject) fs.writeFileSync(path.join(output, 'objects/sha256/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'), '');
  fs.writeFileSync(path.join(output, 'unrelated-build-file'), 'do not export');
  if (options.symlinkArtifact) {
    fs.unlinkSync(path.join(output, 'release.json'));
    fs.symlinkSync(path.join(root, 'private-target'), path.join(output, 'release.json'));
  }
  if (options.symlinkDirectory) {
    fs.renameSync(output, output + '-saved'); fs.symlinkSync(output + '-saved', output);
  }
} else if (args[0] === 'inspect') { console.log('0 false'); }
else if (args[0] === 'rm' && options.cleanupFailure) { process.exit(84); }
`);
}

it("checks the actual baseline exactly rather than accepting newer libc or a harness label", async () => {
  const { isHostBaseline } = await import("../../scripts/host-bundle-baseline-builder.mjs");
  expect(isHostBaseline("linux", "x64", { glibcVersionRuntime: "2.39" })).toBe(true);
  for (const [platform, arch, libc] of [["linux", "x64", "2.43"], ["linux", "x64", "2.36"], ["linux", "arm64", "2.39"], ["darwin", "x64", "2.39"], ["linux", "x64", undefined]]) {
    expect(isHostBaseline(platform, arch, { glibcVersionRuntime: libc })).toBe(false);
  }
});

it("exports a legitimate zero-byte content-addressed object for empty shipped files", () => {
  const f = dockerFixture({ zeroObject: true });
  const result = f.helper();
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(join(f.root, "dist/host-bundle/objects/sha256/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")).length).toBe(0);
});

it("isolates artifact extraction scratch from the build store's module-resolution ancestry", () => {
  const f = dockerFixture();
  const result = f.helper();
  expect(result.status, result.stderr).toBe(0);
  const resolution = JSON.parse(readFileSync(join(f.root, "scratch-resolution"), "utf8"));
  expect(resolution.buildStoreReachable).toBe(false);
  expect(resolution.target).toBe("/scratch");
  expect(dirname(resolution.tmp)).toBe(dirname(resolution.source));
  expect(resolution.tmp.startsWith(resolution.source + "/")).toBe(false);
  expect(JSON.parse(readFileSync(join(f.root, "tmp-state"), "utf8"))).toEqual({ mode: 0o700, entries: [] });
});

it("uses only clean exact tracked source and public metadata, exporting only named artifacts", () => {
  const f = dockerFixture();
  mkdirSync(join(f.root, "node_modules")); writeFileSync(join(f.root, "node_modules/host-native.node"), "untracked-host-binary");
  writeFileSync(join(f.root, "untracked-private"), "do-not-transfer");
  const result = f.helper({ R2_SECRET_ACCESS_KEY: "fixture-private-r2", GITHUB_TOKEN: "fixture-checkout-token", CLAUDE_CODE_OAUTH_TOKEN: "fixture-private-claude", HOST_BUNDLE_DIST_DIR: "dist/isolated-result" });
  expect(result.status, result.stderr).toBe(0);
  const sourceFiles = JSON.parse(readFileSync(join(f.root, "source-files"), "utf8"));
  for (const excluded of [".git", ".env.private", "node_modules", "untracked-private", "bin", "home"]) expect(sourceFiles).not.toContain(excluded);
  expect(JSON.parse(readFileSync(join(f.root, "excluded-paths"), "utf8"))).toEqual([false, false, false]);
  expect(JSON.parse(readFileSync(join(f.root, "context-files"), "utf8"))).toEqual(["Dockerfile"]);
  const args = JSON.parse(readFileSync(join(f.root, "create-args"), "utf8"));
  expect(args).toContain("sha256:" + "a".repeat(64));
  expect(args).toContain("ALL"); expect(args).toContain("no-new-privileges:true"); expect(args).toContain("--read-only");
  expect(args).toContain("MATRIX_BUILD_SHA=" + f.env.MATRIX_BUILD_SHA);
  expect(args).toContain("TMPDIR=/scratch");
  expect(JSON.parse(readFileSync(join(f.root, "tmp-state"), "utf8"))).toEqual({ mode: 0o700, entries: [] });
  for (const privateValue of ["fixture-private-r2", "fixture-checkout-token", "fixture-private-claude", "docker.sock", "--privileged", "--network=host"]) expect(JSON.stringify(args)).not.toContain(privateValue);
  const output = join(f.root, "dist/isolated-result");
  expect(readFileSync(join(output, "matrix-host-bundle.tar.gz"), "utf8")).toBe("fixture-archive");
  expect(existsSync(join(output, "unrelated-build-file"))).toBe(false);
  expect(existsSync(join(output, "stage"))).toBe(false);
  expect(existsSync(readFileSync(join(f.root, "source-path"), "utf8"))).toBe(false);
  const log = readFileSync(join(f.root, "docker-log"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(log.at(-1)).toEqual(["rm", "--force", args[args.indexOf("--name") + 1]]);
});

it.each(["wrong-sha", "dirty", "channel", "escape", "skip-shell", "toolchain-override"])("rejects %s before Docker or any output mutation", kind => {
  const f = dockerFixture();
  const extra: Record<string, string> = {};
  if (kind === "wrong-sha") extra.MATRIX_BUILD_SHA = "b".repeat(40);
  if (kind === "dirty") writeFileSync(join(f.root, "scripts/build-host-bundle.sh"), "dirty\n");
  if (kind === "channel") extra.HOST_BUNDLE_CHANNEL = "stable";
  if (kind === "escape") extra.HOST_BUNDLE_DIST_DIR = "../owner-data";
  if (kind === "skip-shell") extra.HOST_BUNDLE_SKIP_SHELL_BUILD = "true";
  if (kind === "toolchain-override") extra.HOST_BUNDLE_NODE_VERSION = "24.0.0";
  const result = f.helper(extra);
  expect(result.status, result.stderr).toBe(1);
  expect(existsSync(join(f.root, "docker-log"))).toBe(false);
});

it.each(["mismatchedMetadata", "mismatchedRef"] as const)("rejects %s in built metadata and retains the prior output", kind => {
  const f = dockerFixture({ [kind]: true });
  mkdirSync(join(f.root, "dist/host-bundle"), { recursive: true }); writeFileSync(join(f.root, "dist/host-bundle/canary"), "old");
  const result = f.helper();
  expect(result.status, result.stderr).toBe(1); expect(result.stderr).toContain("provenance");
  expect(readFileSync(join(f.root, "dist/host-bundle/canary"), "utf8")).toBe("old");
  expect(existsSync(readFileSync(join(f.root, "source-path"), "utf8"))).toBe(false);
});

it("refuses a symlinked output directory without following it", () => {
  const f = dockerFixture({ symlinkDirectory: true });
  const result = f.helper();
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain("real directories");
});

it("refuses a symlinked host destination before Docker or deleting owner data", () => {
  const f = dockerFixture(); mkdirSync(join(f.root, "owner-data")); writeFileSync(join(f.root, "owner-data/canary"), "keep");
  symlinkSync(join(f.root, "owner-data"), join(f.root, "dist"));
  const result = f.helper();
  expect(result.status, result.stderr).toBe(1);
  expect(existsSync(join(f.root, "docker-log"))).toBe(false);
  expect(readFileSync(join(f.root, "owner-data/canary"), "utf8")).toBe("keep");
});

it("rejects symlinked metadata before reading private target contents", () => {
  const f = dockerFixture({ symlinkArtifact: true }); writeFileSync(join(f.root, "private-target"), "PRIVATE_CONTENT_DO_NOT_ECHO");
  const result = f.helper();
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).not.toContain("PRIVATE_CO");
  expect(result.stderr).toContain("regular");
});

it("removes the exact container when the build deadline interrupts its client", () => {
  const f = dockerFixture({ hang: true });
  const result = f.helper({}, "import {buildInBaseline} from './scripts/host-bundle-baseline-builder.mjs'; await buildInBaseline({deadlineMs:1800}).catch(e=>{console.error(e.message);process.exitCode=1});");
  expect(result.status, result.stderr).toBe(1);
  const args = JSON.parse(readFileSync(join(f.root, "create-args"), "utf8"));
  const log = readFileSync(join(f.root, "docker-log"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(log.at(-1)).toEqual(["rm", "--force", args[args.indexOf("--name") + 1]]);
  expect(existsSync(readFileSync(join(f.root, "source-path"), "utf8"))).toBe(false);
});

it("still removes source and temporary directories if container cleanup fails", () => {
  const f = dockerFixture({ mismatchedMetadata: true, cleanupFailure: true });
  const result = f.helper();
  expect(result.status, result.stderr).toBe(1);
  expect(existsSync(readFileSync(join(f.root, "source-path"), "utf8"))).toBe(false);
});
