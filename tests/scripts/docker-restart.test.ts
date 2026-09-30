import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = process.cwd();
const temporaryDirs: string[] = [];

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "matrix-docker-restart-"));
  temporaryDirs.push(dir);
  mkdirSync(join(dir, "bin"));
  return dir;
}

function executable(dir: string, name: string, body: string) {
  writeFileSync(join(dir, "bin", name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
}

function run(dir: string, script: string, env: Record<string, string> = {}) {
  return spawnSync("bash", ["-c", script], {
    cwd: dir,
    env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, FIXTURE: dir, ...env },
    encoding: "utf8",
    timeout: 10_000,
  });
}

describe("Docker restart regressions", () => {
  it.each([false, true])("only installs dependencies when the lockfile changed (%s)", (changed) => {
    const dir = fixture();
    mkdirSync(join(dir, "node_modules", ".pnpm"), { recursive: true });
    writeFileSync(join(dir, "pnpm-lock.yaml"), changed ? "new" : "old");
    writeFileSync(join(dir, "node_modules", ".pnpm-lock-hash"), `${createHash("md5").update("old").digest("hex")}  pnpm-lock.yaml\n`);
    // Model BusyBox's documented interface: -c is supported; --status is not.
    writeFileSync(join(dir, "bin", "md5sum"), `#!${process.execPath}
const fs = require("node:fs");
const crypto = require("node:crypto");
const args = process.argv.slice(2);
if (args.includes("--status")) process.exit(1);
const digest = crypto.createHash("md5").update(fs.readFileSync("pnpm-lock.yaml")).digest("hex");
if (args[0] === "-c") process.exit(fs.readFileSync(args[1], "utf8").startsWith(digest + "  ") ? 0 : 1);
console.log(digest + "  pnpm-lock.yaml");
`, { mode: 0o755 });
    executable(dir, "pnpm", 'echo install >> "$FIXTURE/installs"');
    const entrypoint = readFileSync(join(root, "distro/docker-dev-entrypoint.sh"), "utf8");
    const setup = entrypoint.match(/ensure_deps\(\) \{[\s\S]*?\n\}\nensure_deps/);
    expect(setup).not.toBeNull();
    const result = run(dir, `set -e\n${setup![0]}\nensure_deps`);
    expect(result.status, result.stderr).toBe(0);
    if (changed) expect(readFileSync(join(dir, "installs"), "utf8")).toBe("install\n");
    else expect(result.stdout).not.toContain("Installing dependencies");
  });

  it("explicitly restarts even when stop/up could reuse an unhealthy running container", () => {
    const dir = fixture();
    executable(dir, "docker", `
echo "$*" >> "$FIXTURE/commands"
case " $* " in
  *" down "*) rm -f "$FIXTURE/started" "$FIXTURE/unhealthy" ;;
  *" restart "*) rm -f "$FIXTURE/unhealthy" ;;
  *" stop "*) touch "$FIXTURE/unhealthy" ;;
  *" up "*) touch "$FIXTURE/started" ;;
  *" ps "*) echo '[]' ;;
esac`);
    executable(dir, "curl", `
[ ! -f "$FIXTURE/unhealthy" ] || exit 1
case " $* " in
  *" -w "*) printf 200 ;;
  *) echo '{"status":"ok"}' ;;
esac`);
    executable(dir, "jq", 'cat >/dev/null; echo ok');
    executable(dir, "sleep", ":");
    const result = run(dir, 'bash "$SCENARIO"', {
      SCENARIO: join(root, "scripts/docker-test/channels.sh"),
      DOCKER_HEALTH_TIMEOUT: "1",
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("Passed: 3");
    expect(readFileSync(join(dir, "commands"), "utf8")).toMatch(/restart --timeout \d+ dev/);
  });

  it.each([false, true])("preserves the failure exit code and cleans up even if diagnostics fail (%s)", (diagnosticsFail) => {
    const dir = fixture();
    executable(dir, "docker", `
echo "$*" >> "$FIXTURE/commands"
case " $* " in
  *" logs "*|*" ps "*) echo diagnostic; ${diagnosticsFail ? "exit 1" : ":"} ;;
  *" down "*) echo removed ;;
esac`);
    const result = run(dir, 'source "$HARNESS"\ntrap cleanup EXIT\nexit 7', {
      HARNESS: join(root, "scripts/docker-test/lib.sh"),
      DOCKER_TEST_LOG_DIR: join(dir, "logs"),
    });
    expect(result.status).toBe(7);
    const commands = readFileSync(join(dir, "commands"), "utf8");
    expect(commands.indexOf("logs ")).toBeGreaterThanOrEqual(0);
    expect(commands.indexOf("logs ")).toBeLessThan(commands.indexOf("down "));
    expect(readFileSync(join(dir, "logs/compose-pre-cleanup.log"), "utf8")).toContain("diagnostic");
    expect(readFileSync(join(dir, "logs/containers-pre-cleanup.log"), "utf8")).toContain("diagnostic");
  });

  it("does not collect failure diagnostics for successful scenarios", () => {
    const dir = fixture();
    executable(dir, "docker", 'echo "$*" >> "$FIXTURE/commands"');
    const result = run(dir, 'source "$HARNESS"\ntrap cleanup EXIT\ntrue', {
      HARNESS: join(root, "scripts/docker-test/lib.sh"),
      DOCKER_TEST_LOG_DIR: join(dir, "logs"),
    });
    expect(result.status).toBe(0);
    expect(readFileSync(join(dir, "commands"), "utf8")).not.toContain("logs ");
  });
});
