import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "matrix-docker-diagnostics-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const docker = `#!/bin/sh
printf '%s\\n' "$*" >> "$CALL_LOG"
if [ "$1" = inspect ]; then
  printf '{"Status":"%s","ExitCode":1,"OOMKilled":false}\\n' "\${FAKE_STATE:-exited}"
  exit 0
fi
shift 3
case "$1" in
  up) exit "\${UP_EXIT:-0}" ;;
  logs) printf 'kernel build: EACCES mkdir .matrix-build-cache\\n'; "${process.execPath}" -e 'process.stdout.write("x".repeat(400000))' ;;
  ps) case "$*" in
    *--quiet*) printf 'abcdef123456\\n' ;;
    *) printf '{"ID":"abcdef123456","State":"%s","Health":"","ExitCode":1}\\n' "\${FAKE_STATE:-exited}" ;;
  esac ;;
esac
`;
  for (const [name, body] of Object.entries({ docker, curl: "#!/bin/sh\nexit 1\n", sleep: "#!/bin/sh\nexit 0\n" })) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALL_LOG: join(dir, "calls"), DOCKER_TEST_LOG_DIR: join(dir, "logs"), DOCKER_HEALTH_TIMEOUT: "2" };
  return { dir, env };
}

describe("Docker failure diagnostics before teardown", () => {
  it.each([
    { exit: 42, state: "exited", expected: "Starting dev container" },
    { exit: 0, state: "exited", expected: "stopped before becoming healthy" },
    { exit: 0, state: "running", expected: "not healthy after 2s" },
  ])("preserves failure evidence before cleanup ($exit/$state)", ({ exit, state, expected }) => {
    const { dir, env } = fixture();
    try {
      const result = spawnSync("bash", [join(root, "scripts/docker-test/fresh-install.sh")], {
        env: { ...env, UP_EXIT: String(exit), FAKE_STATE: state }, encoding: "utf8", timeout: 10_000,
      });
      expect(result.status).toBe(exit || 1);
      expect(result.stdout).toContain(expected);
      const calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
      const logs = calls.findIndex((call) => call.includes("logs --no-color --tail 200 dev"));
      expect(logs).toBeGreaterThan(-1);
      expect(calls.slice(logs)).toContainEqual(expect.stringContaining("inspect --format {{json .State}} abcdef123456"));
      expect(calls.at(-1)).toContain("down -v --timeout 5");
      expect(calls.filter((call) => call.includes("logs --no-color"))).toHaveLength(1);
      const savedLog = readFileSync(join(dir, "logs/pre-cleanup-fresh-install-dev-compose.log"));
      expect(savedLog.byteLength).toBeLessThanOrEqual(262144);
      expect(savedLog.toString()).toContain("kernel build: EACCES mkdir .matrix-build-cache");
      expect(readFileSync(join(dir, "logs/pre-cleanup-fresh-install-dev-state.log"), "utf8")).toContain('"ExitCode":1');
      expect(readFileSync(join(dir, "logs/pre-cleanup-fresh-install-dev-containers.log"), "utf8")).toContain(`"State":"${state}"`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("keeps each failed run-all scenario's bounded evidence in the shared artifact directory", () => {
    const { dir, env } = fixture();
    try {
      const result = spawnSync("bash", [join(root, "scripts/docker-test/run-all.sh")], {
        env: { ...env, SKIP_SCENARIOS: "customized-files multi-user channels recovery resource-limits", FAKE_STATE: "exited" },
        encoding: "utf8", timeout: 10_000,
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("Running: fresh-install");
      expect(result.stdout).toContain("Running: upgrade");
      const files = readdirSync(join(dir, "logs")).sort();
      expect(files).toEqual(["fresh-install", "upgrade"].flatMap(scenario =>
        ["compose", "containers", "state"].map(name => `pre-cleanup-${scenario}-dev-${name}.log`)).sort());
      for (const file of files) {
        expect(readFileSync(join(dir, "logs", file)).byteLength).toBeLessThanOrEqual(262144);
      }
      for (const scenario of ["fresh-install", "upgrade"]) {
        expect(readFileSync(join(dir, "logs", `pre-cleanup-${scenario}-dev-compose.log`), "utf8"))
          .toContain("kernel build: EACCES mkdir .matrix-build-cache");
        expect(readFileSync(join(dir, "logs", `pre-cleanup-${scenario}-dev-state.log`), "utf8")).toContain('"ExitCode":1');
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("retains the bounded legacy collector API when no scenario is supplied", () => {
    const { dir, env } = fixture();
    try {
      const result = spawnSync(process.execPath, [join(root, "scripts/docker-test/diagnostics.mjs"),
        join(root, "docker-compose.dev.yml"), "", "dev", join(dir, "logs")], {
        env, encoding: "utf8", timeout: 10_000,
      });
      expect(result.status).toBe(0);
      expect(readdirSync(join(dir, "logs")).sort()).toEqual([
        "pre-cleanup-dev-compose.log", "pre-cleanup-dev-containers.log", "pre-cleanup-dev-state.log",
      ]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(["../owner-data", "unknown-scenario"])("rejects unrecognized scenario names before writing diagnostics (%s)", scenario => {
    const { dir, env } = fixture();
    try {
      mkdirSync(join(dir, "logs"));
      const result = spawnSync(process.execPath, [join(root, "scripts/docker-test/diagnostics.mjs"),
        join(root, "docker-compose.dev.yml"), "", "dev", join(dir, "logs"), scenario], {
        env, encoding: "utf8", timeout: 10_000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Could not preserve Docker diagnostics");
      expect(readdirSync(join(dir, "logs"))).toEqual([]);
      expect(existsSync(join(dir, "calls"))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("preserves the original failure and still cleans up if diagnostics cannot be written", () => {
    const { dir, env } = fixture();
    try {
      writeFileSync(join(dir, "logs"), "not a directory");
      const result = spawnSync("bash", [join(root, "scripts/docker-test/fresh-install.sh")], {
        env: { ...env, UP_EXIT: "42" }, encoding: "utf8", timeout: 10_000,
      });
      expect(result.status).toBe(42);
      expect(result.stderr).toContain("Could not preserve Docker diagnostics");
      expect(readFileSync(join(dir, "calls"), "utf8").trim().split("\n").at(-1)).toContain("down -v --timeout 5");
      expect(existsSync(join(dir, "logs/pre-cleanup-fresh-install-dev-compose.log"))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("does not overwrite a symlinked diagnostics file", () => {
    const { dir, env } = fixture();
    try {
      mkdirSync(join(dir, "logs"));
      const ownerFile = join(dir, "owner-data");
      writeFileSync(ownerFile, "preserved owner data");
      symlinkSync(ownerFile, join(dir, "logs/pre-cleanup-fresh-install-dev-compose.log"));
      const result = spawnSync("bash", [join(root, "scripts/docker-test/fresh-install.sh")], {
        env: { ...env, UP_EXIT: "42" }, encoding: "utf8", timeout: 10_000,
      });
      expect(result.status).toBe(42);
      expect(readFileSync(ownerFile, "utf8")).toBe("preserved owner data");
      expect(result.stderr).toContain("Could not preserve Docker diagnostics");
      expect(readFileSync(join(dir, "calls"), "utf8").trim().split("\n").at(-1)).toContain("down -v --timeout 5");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
