import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function buildOutputFixture() {
  const fixture = mkdtempSync(join(tmpdir(), "matrix-build-ownership-"));
  mkdirSync(join(fixture, "distro"));
  mkdirSync(join(fixture, "bin"));
  writeFileSync(join(fixture, "distro/docker-dev-entrypoint.sh"), readFileSync(join(root, "distro/docker-dev-entrypoint.sh")));
  for (const name of ["brand", "observability", "terminal-runtime", "kernel"]) {
    mkdirSync(join(fixture, "packages", name, "src"), { recursive: true });
    writeFileSync(join(fixture, "packages", name, "src", "unchanged.ts"), "owner source");
  }
  writeFileSync(join(fixture, "bin/chown"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALL_LOG"\nexit "${CHOWN_EXIT:-0}"\n');
  chmodSync(join(fixture, "bin/chown"), 0o755);
  // An unsupported preparation flag must stop before the dev startup path.
  writeFileSync(join(fixture, "bin/pnpm"), "#!/bin/sh\nexit 23\n");
  chmodSync(join(fixture, "bin/pnpm"), 0o755);
  const run = (extra: Record<string, string> = {}) => spawnSync("bash", [join(fixture, "distro/docker-dev-entrypoint.sh"), "--prepare-build-outputs"], {
    env: { ...process.env, PATH: `${join(fixture, "bin")}:${process.env.PATH}`, CALL_LOG: join(fixture, "calls"), ...extra },
    encoding: "utf8", timeout: 5_000,
  });
  return { fixture, run };
}

describe("Docker development entrypoint dependency layout", () => {
  it("prepares writable compiler outputs and caches without changing source ownership", () => {
    const { fixture, run } = buildOutputFixture();
    try {
      const existingCache = join(fixture, "packages/brand/.matrix-build-cache");
      mkdirSync(existingCache);
      writeFileSync(join(existingCache, ".matrix.tsbuildinfo"), "existing incremental data");
      const result = run();
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const calls = readFileSync(join(fixture, "calls"), "utf8").trim().split("\n");
      expect(calls).toHaveLength(4);
      for (const name of ["brand", "observability", "terminal-runtime", "kernel"]) {
        const base = join(fixture, "packages", name);
        expect(existsSync(join(base, "dist"))).toBe(true);
        expect(existsSync(join(base, ".matrix-build-cache"))).toBe(true);
        expect(calls).toContain(`-hR matrixos:matrixos ${base}/dist ${base}/.matrix-build-cache`);
        expect(readFileSync(join(base, "src/unchanged.ts"), "utf8")).toBe("owner source");
      }
      expect(readFileSync(join(existingCache, ".matrix.tsbuildinfo"), "utf8")).toBe("existing incremental data");
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it("rejects symlinked generated directories before ownership changes", () => {
    const { fixture, run } = buildOutputFixture();
    try {
      const external = join(fixture, "owner-data");
      mkdirSync(external);
      writeFileSync(join(external, "identity"), "preserve me");
      symlinkSync(external, join(fixture, "packages/brand/.matrix-build-cache"));
      const result = run();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Refusing symlinked build output");
      expect(existsSync(join(fixture, "calls"))).toBe(false);
      expect(readFileSync(join(external, "identity"), "utf8")).toBe("preserve me");
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it("does not continue when generated-output ownership fails", () => {
    const { fixture, run } = buildOutputFixture();
    try {
      expect(run({ CHOWN_EXIT: "19" }).status).toBe(19);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it("keeps the global virtual store for host worktrees", () => {
    const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");

    expect(workspace).toContain("enableGlobalVirtualStore: true");
  });

  it("uses a container-local virtual store for every Docker dependency install", () => {
    const entrypoint = readFileSync(
      join(root, "distro/docker-dev-entrypoint.sh"),
      "utf8",
    );
    const installCommands = entrypoint
      .split("\n")
      .filter((line) => line.includes("pnpm install --frozen-lockfile"));

    expect(installCommands.length).toBeGreaterThan(0);
    for (const command of installCommands) {
      expect(command).toContain("--config.enableGlobalVirtualStore=false");
    }
  });

  it("builds the brand workspace before starting the shell", () => {
    const entrypoint = readFileSync(
      join(root, "distro/docker-dev-entrypoint.sh"),
      "utf8",
    );
    const brandBuild = entrypoint.indexOf(
      "pnpm --filter @matrix-os/brand build",
    );
    const shellStart = entrypoint.indexOf(
      "pnpm --filter shell exec next dev -p 3000",
    );

    expect(brandBuild).toBeGreaterThan(-1);
    expect(shellStart).toBeGreaterThan(brandBuild);
  });

  it("builds the terminal runtime before starting the gateway", () => {
    const fixture = mkdtempSync(join(tmpdir(), "matrix-entrypoint-"));
    const bin = join(fixture, "bin");
    const calls = join(fixture, "calls.log");
    mkdirSync(bin);

    for (const command of ["pnpm", "node"]) {
      const executable = join(bin, command);
      writeFileSync(
        executable,
        `#!/bin/sh\nprintf '%s %s\\n' '${command}' "$*" >> "$CALL_LOG"\n`,
      );
      chmodSync(executable, 0o755);
    }

    const entrypoint = join(root, "distro/docker-dev-entrypoint.sh");
    const env = {
      ...process.env,
      CALL_LOG: calls,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    };

    try {
      const prepare = spawnSync("bash", [entrypoint, "--prepare-gateway"], {
        cwd: root,
        env,
        encoding: "utf8",
      });
      const launch = spawnSync("bash", [entrypoint, "--launch-gateway"], {
        cwd: root,
        env,
        encoding: "utf8",
      });

      expect(prepare.stderr).toBe("");
      expect(prepare.status).toBe(0);
      expect(launch.stderr).toBe("");
      expect(launch.status).toBe(0);
      expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([
        "pnpm --filter @matrix-os/terminal-runtime build",
        "node --import=tsx --watch packages/gateway/src/main.ts",
      ]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
