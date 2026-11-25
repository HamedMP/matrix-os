import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT = join(process.cwd(), "scripts/staging-slot.sh");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Outcome: a failed `staging-slot.sh up` frees the slot it claimed.
// Fault detected: the EXIT trap reading cmd_up's out-of-scope local `slot`,
// which errors under `set -u` and leaves the slot locked until --reap.
function runUpWithFailingDocker(failAt: "db" | "compose") {
  const root = mkdtempSync(join(tmpdir(), "staging-slot-"));
  roots.push(root);
  const bin = join(root, "bin");
  const state = join(root, "state");
  const worktree = join(root, "worktree");
  mkdirSync(bin);
  mkdirSync(worktree);
  writeFileSync(join(worktree, "Dockerfile.dev"), "FROM scratch\n");
  const git = (...args: string[]) => spawnSync("git", ["-C", worktree, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init");

  // `docker compose ... up --wait staging-postgres` is the DB step; any other
  // `up` is the slot compose. Fail the requested one.
  const dockerStub =
    failAt === "db"
      ? '#!/bin/sh\ncase "$*" in *staging-postgres*) exit 1;; esac\nexit 0\n'
      : '#!/bin/sh\ncase "$*" in *exec*) echo 1; exit 0;; *staging-postgres*) exit 0;; esac\nexit 1\n';
  writeFileSync(join(bin, "docker"), dockerStub);
  writeFileSync(join(bin, "setfacl"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "docker"), 0o755);
  chmodSync(join(bin, "setfacl"), 0o755);

  const result = spawnSync("bash", [SCRIPT, "up", worktree], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      STAGING_SLOT_STATE_DIR: state,
      STAGING_SLOT_ENV_FILE: join(root, ".env"),
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  return { result, slotFile: join(state, "slot-1.json") };
}

describe("staging-slot.sh up releases the claimed slot on failure", () => {
  it.each(["db", "compose"] as const)("frees slot 1 when the %s step fails", (failAt) => {
    const { result, slotFile } = runUpWithFailingDocker(failAt);
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stdout, result.stderr).toContain("claimed slot 1");
    expect(result.stderr).not.toContain("unbound variable");
    expect(existsSync(slotFile)).toBe(false);
  });
});
