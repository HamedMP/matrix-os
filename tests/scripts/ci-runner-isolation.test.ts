import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve("scripts/ci/runner");
const sha = "a".repeat(40);

function invoke(args: string[], failure = false) {
  const dir = mkdtempSync(resolve(tmpdir(), "matrix-runner-test-"));
  const log = resolve(dir, "calls");
  writeFileSync(resolve(dir, "docker"), `#!/bin/bash\nprintf '%s\\n' "$*" >> "$CALLS"\nif [[ "$1" == create ]]; then echo test-container; fi\nif [[ "$1" == wait ]]; then if [[ "$FAIL_START" == 1 ]]; then echo 42; else echo 0; fi; fi\n`);
  chmodSync(resolve(dir, "docker"), 0o755);
  writeFileSync(resolve(dir, "flock"), "#!/bin/bash\nexit 0\n");
  chmodSync(resolve(dir, "flock"), 0o755);
  writeFileSync(resolve(dir, "timeout"), '#!/bin/bash\nshift 3\nexec "$@"\n');
  chmodSync(resolve(dir, "timeout"), 0o755);
  try {
    const result = spawnSync("bash", [resolve(root, "start-ephemeral.sh"), ...args], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CALLS: log,
        FAIL_START: failure ? "1" : "0", MATRIX_CI_STATE_DIR: dir },
    });
    return { result, calls: (() => { try { return readFileSync(log, "utf8"); } catch { return ""; } })() };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("disposable manual CI benchmark admission and isolation", () => {
  it.each([["main", "unit", "8"], [sha, "unit;id", "8"], [sha, "unit", "17"], [sha, "unit", "0"]])(
    "rejects invalid request before allocating a container: %s %s %s", (...args) => {
      const { result, calls } = invoke(args);
      expect(result.status).not.toBe(0);
      expect(calls).toBe("");
    },
  );
  it("runs a reviewed immutable SHA as nonroot with bounded resources and no host mounts", () => {
    const { result, calls } = invoke([sha, "unit", "8"]);
    expect(result.status).toBe(0);
    const create = calls.split("\n").find((line) => line.startsWith("create "))!;
    expect(create).toContain("--user 10001:10001");
    expect(create).toContain("--cap-drop ALL");
    expect(create).toContain("--security-opt no-new-privileges:true");
    expect(create).toContain("--cpus 16");
    expect(create).toContain("--memory 56g");
    expect(create).toContain("--memory-swap 56g");
    expect(create).toContain("--pids-limit 4096");
    expect(create).toContain("--network matrix-ci");
    expect(create).not.toMatch(/--privileged|--volume|--mount|--network host|docker\.sock/);
    expect(create).toContain(`${sha} unit 8`);
    expect(calls).toContain("rm --force test-container");
  });
  it("propagates job failures and removes the container", () => {
    const { result, calls } = invoke([sha, "unit", "8"], true);
    expect(result.status).toBe(42);
    expect(calls).toContain("rm --force test-container");
  });
  it("never registers an open GitHub runner or accepts a registration token", () => {
    const script = readFileSync(resolve(root, "start-ephemeral.sh"), "utf8");
    expect(script).not.toMatch(/config\.sh|run\.sh|--token|jitconfig|actions\/runners/);
    expect(invoke([sha, "github-runner", "8"]).calls).toBe("");
  });
  it("pins toolchain downloads, verifies checksums, and drops root in the image", () => {
    const image = readFileSync(resolve(root, "Dockerfile"), "utf8");
    expect(image).toMatch(/FROM ubuntu:24\.04@sha256:[a-f0-9]{64}/);
    expect(image).toContain("node-v24.14.1-linux-x64.tar.xz");
    expect(image).toContain("pnpm-10.33.4.tgz");
    expect(image).toContain("bun-v1.3.10");
    expect(image.match(/sha256sum -c/g)).toHaveLength(3);
    expect(image).toContain("USER 10001:10001");
  });
  it("checks immutable checkout and a frozen lockfile before executing suites", () => {
    const script = readFileSync(resolve(root, "benchmark.sh"), "utf8");
    expect(script).toContain('git rev-parse HEAD');
    expect(script).toContain('pnpm install --frozen-lockfile');
    expect(script).toContain('https://github.com/HamedMP/matrix-os.git');
    expect(script).not.toMatch(/eval |source \/|--with-deps|GITHUB_TOKEN|HETZNER/);
  });
  it("all shell entrypoints have valid syntax", () => {
    for (const file of ["start-ephemeral.sh", "benchmark.sh", "bootstrap-host.sh"])
      expect(() => execFileSync("bash", ["-n", resolve(root, file)])).not.toThrow();
  });
});
