import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statfsSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";

const fixtures: string[] = [];
afterEach(() => {
  for (const root of fixtures.splice(0)) {
    if (existsSync(join(root, "source-path"))) rmSync(dirname(readFileSync(join(root, "source-path"), "utf8")), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "storage-diagnostics-private-name-")); fixtures.push(root);
  for (const directory of ["scripts", "bin", "home"]) mkdirSync(join(root, directory));
  for (const file of ["build-host-bundle.sh", "host-bundle-baseline-builder.mjs", "host-bundle-builder.Dockerfile", "host-bundle-storage-diagnostics.mjs"]) {
    if (existsSync(join(process.cwd(), "scripts", file))) cpSync(join(process.cwd(), "scripts", file), join(root, "scripts", file));
  }
  symlinkSync(process.execPath, join(root, "bin/node"));
  writeFileSync(join(root, "bin/pnpm"), "#!/bin/sh\nexit 91\n", { mode: 0o755 });
  writeFileSync(join(root, "bin/docker"), `#!${process.execPath}
const fs=require('node:fs'), path=require('node:path'), args=process.argv.slice(2), root=process.env.FIXTURE_ROOT;
if(args[0]==='build') fs.writeFileSync(args[args.indexOf('--iidfile')+1], 'sha256:'+'a'.repeat(64));
if(args[0]==='create') {
 const mounts=args.flatMap((arg,i)=>arg==='--mount'?[args[i+1]]:[]);
 fs.writeFileSync(path.join(root,'source-path'), mounts.find(value=>value.endsWith('dst=/work')).split(',src=')[1].split(',dst=')[0]);
 fs.writeFileSync(path.join(root,'create-args'), JSON.stringify(args));
}
if(args[0]==='start') { console.log('DOCKER_START'); process.exit(83); }
if(args[0]==='rm') { fs.writeFileSync(path.join(root,'removed'), 'yes'); console.log('DOCKER_REMOVED'); }
`, { mode: 0o755 });
  const git = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0); return result.stdout.trim();
  };
  git(["init", "-q"]); git(["add", "scripts"]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
  const env = { PATH: join(root, "bin") + delimiter + process.env.PATH, HOME: join(root, "home"), FIXTURE_ROOT: root,
    MATRIX_BUILD_SHA: git(["rev-parse", "HEAD"]), MATRIX_BUILD_REF: "fixture", HOST_BUNDLE_VERSION: "v2026.11.05-fixture", HOST_BUNDLE_CHANNEL: "none",
    PRIVATE_TOKEN: "do-not-log-private-token", GITHUB_TOKEN: "do-not-log-github-token", TMP_OVERRIDE: "do-not-log-raw-temp-override" };
  return { root, env, freeze: () => {
    git(["add", "scripts"]); git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "diagnostic fault fixture"]);
    env.MATRIX_BUILD_SHA = git(["rev-parse", "HEAD"]);
  }, run: () => spawnSync(process.execPath, ["scripts/host-bundle-baseline-builder.mjs"], { cwd: root, env, encoding: "utf8", timeout: 20_000 }) };
}

/** Exercise the real Bash entry's /work branch with fixture command routing.
 * pwd/native-baseline are explicit fixture stubs, not Linux mount/native proof.
 * Every actual write remains inside this test's owned HOST_BUNDLE_DIST_DIR. */
function isolatedBash(f: ReturnType<typeof fixture>) {
  rmSync(join(f.root, "bin/node"));
  writeFileSync(join(f.root, "bin/node"), `#!${process.execPath}
const child = require('node:child_process'), path = require('node:path'), args = process.argv.slice(2);
if (args[0]?.startsWith('/work/scripts/')) args[0] = path.join(process.env.FIXTURE_ROOT, 'scripts', path.basename(args[0]));
const result = child.spawnSync(process.execPath, args, { stdio:'inherit', env:process.env, timeout:8000 });
process.exit(result.status ?? 1);
`, { mode: 0o755 });
  return spawnSync("bash", ["-c", "pwd() { printf '%s\\n' /work; }; export -f pwd; exec bash scripts/build-host-bundle.sh"], {
    cwd: f.root, env: { ...f.env, HOST_BUNDLE_DIST_DIR: join(f.root, "dist/owned-bash-output") }, encoding: "utf8", timeout: 12_000,
  });
}

function snapshots(stdout: string) {
  return stdout.split("\n").filter(line => line.startsWith('{"kind":"host-bundle-storage"')).map(line => JSON.parse(line));
}

it("records bounded before/failure filesystem facts through the actual builder before removing its owned source", () => {
  const f = fixture(), result = f.run();
  expect(result.status, result.stderr).toBe(83);
  const records = snapshots(result.stdout);
  expect(records.map(record => [record.scope, record.phase])).toEqual([["outer", "before"], ["outer", "failure"]]);
  for (const record of records) {
    expect(record.filesystems.map((value: { role: string }) => value.role)).toEqual(["source", "scratch", "output"]);
    for (const fs of record.filesystems) {
      expect(Object.keys(fs).sort()).toEqual(["availableBytes", "filesystem", "freeBytes", "freeInodes", "role", "totalBytes", "totalInodes"].sort());
      expect(fs.filesystem).toMatch(/^(ext|xfs|btrfs|overlay|tmpfs|other)$/);
      for (const key of ["availableBytes", "freeBytes", "freeInodes", "totalBytes", "totalInodes"]) expect(fs[key]).toMatch(/^\d+$/);
      expect(BigInt(fs.totalBytes)).toBeGreaterThan(0n);
    }
  }
  expect(result.stdout.indexOf('"phase":"before"')).toBeLessThan(result.stdout.indexOf("DOCKER_START"));
  expect(result.stdout.indexOf('"phase":"failure"')).toBeGreaterThan(result.stdout.indexOf("DOCKER_START"));
  const diagnosticText = JSON.stringify(records);
  for (const value of [f.root, tmpdir(), "private-token", "github-token", "raw-temp-override", "/dev/", "PRIVATE_TOKEN", "mount"]) expect(diagnosticText).not.toContain(value);
  expect(existsSync(join(f.root, "removed"))).toBe(true);
  expect(existsSync(readFileSync(join(f.root, "source-path"), "utf8"))).toBe(false);
});

it("retains the actual Bash entry's build exit when its diagnostic CLI fails (baseline decision stubbed)", () => {
  const f = fixture();
  // Exercise Bash orchestration only; this stub is not native baseline evidence.
  writeFileSync(join(f.root, "scripts/host-bundle-baseline-builder.mjs"), "if (process.argv[2] === '--check') process.exit(0); process.exit(92);\n");
  writeFileSync(join(f.root, "scripts/host-bundle-storage-diagnostics.mjs"), "console.log(JSON.stringify({kind:'host-bundle-storage',scope:'inner',phase:process.argv[3],status:'unavailable'})); throw new Error('do-not-log-inner-diagnostic-path-or-token');\n");
  writeFileSync(join(f.root, "bin/pnpm"), "#!/bin/sh\nprintf '%s\\n' ORIGINAL_BUILD_FAILURE >&2\nexit 91\n", { mode: 0o755 });
  const result = isolatedBash(f);
  expect(result.status, result.stderr).toBe(91);
  expect(snapshots(result.stdout)).toEqual([
    { kind: "host-bundle-storage", scope: "inner", phase: "before", status: "unavailable" },
    { kind: "host-bundle-storage", scope: "inner", phase: "failure", status: "unavailable" },
  ]);
  expect(result.stderr).toContain("ORIGINAL_BUILD_FAILURE");
  expect(result.stderr).not.toContain("do-not-log-inner-diagnostic-path-or-token");
  expect(existsSync(join(f.root, "removed"))).toBe(false);
});

it.each([
  { scenario: "explicit exit", code: 47 },
  { scenario: "missing Clerk key", code: 1 },
])("samples failures that exit the isolated Bash process directly", ({ scenario, code }) => {
  const f = fixture(), path = join(f.root, "scripts/build-host-bundle.sh");
  const script = readFileSync(path, "utf8");
  const firstBuild = "pnpm install --frozen-lockfile --config.enableGlobalVirtualStore=false";
  const keyGuard = script.split('smoke-gateway-production-loader.mjs"\n')[1]?.split("# In-app auth routes")[0];
  expect(keyGuard).toContain("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
  expect(script).toContain(firstBuild);
  writeFileSync(path, script.replace(firstBuild, scenario === "explicit exit" ? "exit 47" : `${keyGuard}\nexit 0`));
  writeFileSync(join(f.root, "scripts/host-bundle-baseline-builder.mjs"), "process.exit(0);\n");
  writeFileSync(join(f.root, "scripts/host-bundle-storage-diagnostics.mjs"),
    "console.log(JSON.stringify({kind:'host-bundle-storage',scope:'inner',phase:process.argv[3]}));\n");
  const result = isolatedBash(f);
  expect(result.status, result.stderr).toBe(code);
  expect(snapshots(result.stdout).map(record => record.phase)).toEqual(["before", "failure"]);
});

it.each([
  { state: "unset", key: undefined, exit: 1 },
  { state: "empty", key: "", exit: 1 },
  { state: "set", key: "pk_test_Y2xlcmsuZXhhbXBsZS5jb20k", exit: 93 },
])("requires a Clerk publishable key before building the shell ($state)", ({ key, exit }) => {
  const f = fixture();
  // Run the unchanged Bash entry with owned fixture artifacts in place of builds.
  writeFileSync(join(f.root, "scripts/host-bundle-baseline-builder.mjs"), "process.exit(process.argv[2] === '--check' ? 0 : 92);\n");
  mkdirSync(join(f.root, "node_modules/tsx"), { recursive: true });
  writeFileSync(join(f.root, "node_modules/tsx/index.js"), "");
  writeFileSync(join(f.root, "scripts/smoke-gateway-production-loader.mjs"), "");
  writeFileSync(join(f.root, "bin/pnpm"), `#!/bin/sh
if [ "$1" = "--filter" ] && [ "$2" = "./shell" ]; then
  echo SHELL_BUILD_REACHED >&2
  exit 93
fi
exit 0
`, { mode: 0o755 });
  for (const path of [
    "dist/chat/hermes-routine-tool.py",
    "dist/coding-agents/opencode-routine-tool.mjs",
    "dist/collaboration/filesystem-identity.node",
    "dist/terminal/terminal-writer.node",
    "src/app-runtime/fixture.html",
  ]) {
    const target = join(f.root, "packages/gateway", path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "");
  }
  const result = spawnSync("bash", ["scripts/build-host-bundle.sh"], {
    cwd: f.root, env: { ...f.env, ...(key === undefined ? {} : { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: key }) },
    encoding: "utf8", timeout: 5_000,
  });
  expect(result.status, result.stderr).toBe(exit);
  if (exit === 1) {
    expect(result.stderr).toContain("set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY before building the customer host bundle");
    expect(result.stderr).not.toContain("SHELL_BUILD_REACHED");
  } else {
    expect(result.stderr).toContain("SHELL_BUILD_REACHED");
  }
});

it.each(["throw", "hang", "unsafe-json", "oversized", "killed"])("preserves the original build failure and owned cleanup when the diagnostic process has a %s fault", kind => {
  const f = fixture(), path = join(f.root, "scripts/host-bundle-storage-diagnostics.mjs");
  const fault = {
    throw: "throw new Error('do-not-log-provider-path-or-token');",
    killed: "process.kill(process.pid, 'SIGKILL');",
    hang: "setInterval(() => {}, 1000); await new Promise(() => {});",
    "unsafe-json": "console.log(JSON.stringify({kind:'host-bundle-storage',scope:process.argv[3],phase:process.argv[4],secret:'do-not-log-provider-path-or-token'})); process.exit(0);",
    oversized: "console.log('do-not-log-provider-path-or-token'.repeat(1000)); process.exit(0);",
  }[kind]!;
  // Fault only the subprocess boundary; retain the real parent orchestrator.
  writeFileSync(path, `if(process.argv[2]==='--collect') { ${fault} }\n` + readFileSync(path, "utf8")); f.freeze();
  const started = Date.now(), result = f.run();
  expect(result.status, result.stderr).toBe(83);
  expect(Date.now() - started).toBeLessThan(12_000);
  expect(snapshots(result.stdout)).toEqual([
    { kind: "host-bundle-storage", scope: "outer", phase: "before", status: "unavailable" },
    { kind: "host-bundle-storage", scope: "outer", phase: "failure", status: "unavailable" },
  ]);
  expect(result.stdout + result.stderr).not.toContain("do-not-log-provider-path-or-token");
  expect(existsSync(join(f.root, "removed"))).toBe(true);
  expect(existsSync(readFileSync(join(f.root, "source-path"), "utf8"))).toBe(false);
}, 15_000);

it("gives the diagnostic subprocess an empty environment rather than host credentials or temp overrides", () => {
  const f = fixture(), path = join(f.root, "scripts/host-bundle-storage-diagnostics.mjs");
  // macOS adds its own __CF_USER_TEXT_ENCODING even to an env:{} spawn.
  writeFileSync(path, "if(process.argv[2]==='--collect' && Object.keys(process.env).some(key => key!=='__CF_USER_TEXT_ENCODING')) throw new Error('environment leaked');\n" + readFileSync(path, "utf8")); f.freeze();
  const result = f.run();
  expect(result.status, result.stderr).toBe(83);
  expect(snapshots(result.stdout).map(record => record.filesystems.length)).toEqual([3, 3]);
  const createArgs = readFileSync(join(f.root, "create-args"), "utf8");
  for (const value of ["PRIVATE_TOKEN", "GITHUB_TOKEN", "TMP_OVERRIDE", "do-not-log"]) expect(createArgs).not.toContain(value);
});

it("collects the inner four-role schema from owned filesystem fixtures without claiming a Linux mount test", () => {
  const f = fixture(), output = join(f.root, "not-created/output");
  const result = spawnSync(process.execPath, ["scripts/host-bundle-storage-diagnostics.mjs", "--collect", "inner", "before", f.root, f.root, output, f.root], {
    cwd: f.root, env: {}, encoding: "utf8", timeout: 5000,
  });
  expect(result.status, result.stderr).toBe(0);
  const [record] = snapshots(result.stdout), actual = statfsSync(f.root, { bigint: true });
  expect(record.scope).toBe("inner");
  expect(record.filesystems.map((value: { role: string }) => value.role)).toEqual(["source", "scratch", "output", "tmp"]);
  for (const value of record.filesystems) {
    expect(value.totalBytes).toBe(String(actual.blocks * actual.bsize));
    // APFS reports a dynamic inode total; a second sample is not the same instant.
    expect(BigInt(value.totalInodes)).toBeGreaterThan(0n);
    expect(BigInt(value.freeInodes)).toBeLessThanOrEqual(BigInt(value.totalInodes));
  }
  expect(existsSync(output)).toBe(false);
});

it("normal direct-baseline Bash never invokes sandbox diagnostics or its failure trap", () => {
  const f = fixture();
  writeFileSync(join(f.root, "scripts/host-bundle-baseline-builder.mjs"), "if(process.argv[2]==='--check') process.exit(0); process.exit(92);\n");
  writeFileSync(join(f.root, "scripts/host-bundle-storage-diagnostics.mjs"), "import {writeFileSync} from 'node:fs'; writeFileSync(process.env.FIXTURE_ROOT+'/unexpected-diagnostic', 'called'); console.log('UNEXPECTED_DIAGNOSTIC'); process.exit(78);\n");
  const result = spawnSync("bash", ["scripts/build-host-bundle.sh"], { cwd: f.root, env: f.env, encoding: "utf8", timeout: 10_000 });
  expect(result.status, result.stderr).toBe(91);
  expect(existsSync(join(f.root, "unexpected-diagnostic"))).toBe(false);
  expect(result.stdout).not.toContain("UNEXPECTED_DIAGNOSTIC");
});

it.each(["before", "failure"])("preserves original build exit and cleanup when %s-phase diagnostic reporting throws", phase => {
  const f = fixture(), path = join(f.root, "scripts/host-bundle-storage-diagnostics.mjs");
  writeFileSync(path, `if (process.argv[2] !== '--collect') {
  const diagnosticWrite = process.stdout.write;
  process.stdout.write = function (text, ...rest) {
    if (typeof text === 'string' && text.startsWith('{"kind":"host-bundle-storage"') && text.includes(${JSON.stringify('"phase":"' + phase + '"')})) throw new Error('do-not-log-diagnostic-path-or-token');
    return diagnosticWrite.call(this, text, ...rest);
  };
}
` + readFileSync(path, "utf8")); f.freeze();
  const result = f.run();
  expect(result.status, result.stderr).toBe(83);
  expect(result.stderr).toContain("docker failed (83)");
  expect(result.stdout + result.stderr).not.toContain("do-not-log-diagnostic-path-or-token");
  expect(snapshots(result.stdout).map(record => record.phase)).toEqual([phase === "before" ? "failure" : "before"]);
  expect(existsSync(join(f.root, "removed"))).toBe(true);
  expect(existsSync(readFileSync(join(f.root, "source-path"), "utf8"))).toBe(false);
});

it("preserves build failure and cleanup when the diagnostic stdout write fails asynchronously", () => {
  const f = fixture(), path = join(f.root, "scripts/host-bundle-storage-diagnostics.mjs");
  writeFileSync(path, `import { Console as FixtureConsole } from 'node:console';
import { Writable as FixtureWritable } from 'node:stream';
import { writeFileSync as fixtureWrite } from 'node:fs';
if (process.argv[2] !== '--collect') {
  const original = process.stdout;
  const stdout = new FixtureWritable({
    write(chunk, encoding, done) {
      const text = chunk.toString();
      if (text.startsWith('{"kind":"host-bundle-storage"') && text.includes('"phase":"failure"')) {
        setImmediate(() => done(Object.assign(new Error('do-not-log-diagnostic-pipe-failure'), { code: 'EPIPE' })));
      } else original.write(chunk, encoding, done);
    },
  });
  Object.defineProperty(process, 'stdout', { value: stdout });
  globalThis.console = new FixtureConsole({ stdout, stderr: process.stderr, ignoreErrors: false });
  process.once('exit', () => fixtureWrite(process.env.FIXTURE_ROOT + '/diagnostic-error-listeners', String(stdout.listenerCount('error'))));
}
` + readFileSync(path, "utf8")); f.freeze();
  const result = f.run();
  expect(result.status, result.stderr).toBe(83);
  expect(result.stderr).toContain("docker failed (83)");
  expect(result.stdout + result.stderr).not.toContain("do-not-log-diagnostic-pipe-failure");
  expect(snapshots(result.stdout).map(record => record.phase)).toEqual(["before"]);
  expect(existsSync(join(f.root, "removed"))).toBe(true);
  expect(existsSync(readFileSync(join(f.root, "source-path"), "utf8"))).toBe(false);
  expect(readFileSync(join(f.root, "diagnostic-error-listeners"), "utf8")).toBe("0");
});

it("preserves original failure and cleanup if spawning the diagnostic child throws", () => {
  const f = fixture(), path = join(f.root, "scripts/host-bundle-storage-diagnostics.mjs");
  writeFileSync(path, `import {createRequire as diagnosticRequire, syncBuiltinESMExports as diagnosticSync} from 'node:module';
const diagnosticChildren = diagnosticRequire(import.meta.url)('node:child_process'), diagnosticSpawn = diagnosticChildren.spawn;
diagnosticChildren.spawn = function(command, args, options) {
  if(args?.[1]==='--collect' && args[0]?.endsWith('/host-bundle-storage-diagnostics.mjs')) throw new Error('do-not-log-spawn-path-or-token');
  return diagnosticSpawn.call(this, command, args, options);
}; diagnosticSync();
` + readFileSync(path, "utf8")); f.freeze();
  const result = f.run();
  expect(result.status, result.stderr).toBe(83);
  expect(snapshots(result.stdout)).toEqual([
    { kind: "host-bundle-storage", scope: "outer", phase: "before", status: "unavailable" },
    { kind: "host-bundle-storage", scope: "outer", phase: "failure", status: "unavailable" },
  ]);
  expect(result.stdout + result.stderr).not.toContain("do-not-log-spawn-path-or-token");
  expect(existsSync(join(f.root, "removed"))).toBe(true);
  expect(existsSync(readFileSync(join(f.root, "source-path"), "utf8"))).toBe(false);
});
