import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = process.cwd();

// Stand-ins for the commands the dependency watcher runs. md5sum behaves like
// Alpine's BusyBox build (no long options such as --status) and uses the
// one-word fixture lockfile content as its digest so the events stay readable.
const WATCHER_STUBS: Record<string, string> = {
  md5sum: `#!/bin/sh
case "$1" in
  -c)
    [ -f "$2" ] || { echo "md5sum: can't open '$2'" >&2; exit 1; }
    while read -r digest file; do
      if [ "$(cat "$file" 2>/dev/null)" = "$digest" ]; then
        echo "$file: OK"
      else
        echo "$file: FAILED"
        exit 1
      fi
    done < "$2"
    ;;
  -*)
    echo "md5sum: unrecognized option '$1'" >&2
    exit 1
    ;;
  *)
    [ -f "$1" ] || { echo "md5sum: can't open '$1'" >&2; exit 1; }
    printf '%s  %s\\n' "$(cat "$1")" "$1"
    ;;
esac
`,
  pnpm: `#!/bin/sh
result=$(cat "$WATCH_FIXTURE/install-result")
printf 'install %s %s\\n' "$(cat pnpm-lock.yaml)" "$result" >> "$WATCH_FIXTURE/events.log"
[ "$result" = ok ]
`,
  // Each poll records which lockfile the hash says is installed, then applies
  // the next scripted step. Running out of steps ends the watcher loop.
  sleep: `#!/bin/sh
printf 'installed %s\\n' "$(cut -d' ' -f1 node_modules/.pnpm-lock-hash 2>/dev/null)" >> "$WATCH_FIXTURE/events.log"
step=$(( $(cat "$WATCH_FIXTURE/step") + 1 ))
printf '%s\\n' "$step" > "$WATCH_FIXTURE/step"
line=$(sed -n "\${step}p" "$WATCH_FIXTURE/steps")
[ -n "$line" ] || exit 1
set -- $line
if [ "$1" = "-" ]; then rm -f pnpm-lock.yaml; else printf '%s\\n' "$1" > pnpm-lock.yaml; fi
printf '%s\\n' "$2" > "$WATCH_FIXTURE/install-result"
`,
};

type WatchStep = {
  // null removes the lockfile, like a checkout caught mid-write.
  lockfile: string | null;
  install: "ok" | "fail";
};

function runDependencyWatcher(installedLockfile: string, steps: WatchStep[]) {
  const fixture = mkdtempSync(join(tmpdir(), "matrix-dep-watch-"));
  const bin = join(fixture, "bin");
  const entrypoint = join(fixture, "distro/docker-dev-entrypoint.sh");
  const events = join(fixture, "events.log");
  mkdirSync(bin);
  mkdirSync(join(fixture, "distro"));
  mkdirSync(join(fixture, "node_modules"));
  // The script runs from the directory above its own, so a copy keeps the
  // watcher away from the repository's real lockfile and node_modules.
  copyFileSync(join(root, "distro/docker-dev-entrypoint.sh"), entrypoint);
  writeFileSync(join(fixture, "pnpm-lock.yaml"), `${installedLockfile}\n`);
  writeFileSync(
    join(fixture, "node_modules/.pnpm-lock-hash"),
    `${installedLockfile}  pnpm-lock.yaml\n`,
  );
  writeFileSync(join(fixture, "step"), "0\n");
  writeFileSync(
    join(fixture, "steps"),
    steps.map((step) => `${step.lockfile ?? "-"} ${step.install}\n`).join(""),
  );
  writeFileSync(events, "");
  for (const [command, source] of Object.entries(WATCHER_STUBS)) {
    writeFileSync(join(bin, command), source);
    chmodSync(join(bin, command), 0o755);
  }

  try {
    const result = spawnSync("bash", [entrypoint, "--watch-deps"], {
      cwd: fixture,
      env: {
        ...process.env,
        WATCH_FIXTURE: fixture,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    return {
      status: result.status,
      stderr: result.stderr,
      events: readFileSync(events, "utf8").trim().split("\n"),
    };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

describe("Docker development entrypoint dependency layout", () => {
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
      "pnpm --filter shell exec next dev --webpack -p 3000",
    );

    expect(brandBuild).toBeGreaterThan(-1);
    expect(shellStart).toBeGreaterThan(brandBuild);
  });

  it("starts the shell with the same bundler as the shell's own dev script", () => {
    const entrypoint = readFileSync(
      join(root, "distro/docker-dev-entrypoint.sh"),
      "utf8",
    );
    const shellPackage = JSON.parse(
      readFileSync(join(root, "shell/package.json"), "utf8"),
    ) as { scripts: { dev: string } };

    expect(shellPackage.scripts.dev).toContain("--webpack");
    expect(entrypoint).toContain("exec next dev --webpack -p 3000");
  });

  it("checks the lockfile hash with flags BusyBox md5sum supports", () => {
    const entrypoint = readFileSync(
      join(root, "distro/docker-dev-entrypoint.sh"),
      "utf8",
    );
    const md5Lines = entrypoint
      .split("\n")
      .filter((line) => line.includes("md5sum") && !line.trim().startsWith("#"));

    expect(md5Lines.length).toBeGreaterThan(0);
    for (const line of md5Lines) {
      expect(line).not.toContain("--status");
    }
    expect(entrypoint).toContain(
      "md5sum -c node_modules/.pnpm-lock-hash >/dev/null 2>&1",
    );
  });

  it("retries a failed dependency install only after the lockfile changes again", () => {
    const run = runDependencyWatcher("lock-b", [
      { lockfile: "lock-a", install: "fail" },
      { lockfile: "lock-a", install: "ok" },
      { lockfile: null, install: "ok" },
      { lockfile: "lock-c", install: "ok" },
      { lockfile: "lock-c", install: "ok" },
    ]);

    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.events).toEqual([
      "installed lock-b",
      "install lock-a fail",
      // The failed hash is not recorded and the same content is not retried.
      "installed lock-b",
      // A missing lockfile is skipped instead of installed.
      "installed lock-b",
      "installed lock-b",
      "install lock-c ok",
      // A successful install records the hash, so the next poll is a no-op.
      "installed lock-c",
      "installed lock-c",
    ]);
  });

  it("retries a failed lockfile again after a return to the installed one", () => {
    const run = runDependencyWatcher("lock-b", [
      { lockfile: "lock-a", install: "fail" },
      { lockfile: "lock-b", install: "ok" },
      { lockfile: "lock-a", install: "ok" },
      { lockfile: "lock-a", install: "ok" },
    ]);

    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.events).toEqual([
      "installed lock-b",
      "install lock-a fail",
      "installed lock-b",
      "installed lock-b",
      "install lock-a ok",
      "installed lock-a",
      "installed lock-a",
    ]);
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
