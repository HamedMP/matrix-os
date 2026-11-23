import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Found in review: a self-hosted owner account need not have a group named after
// it (alice in staff). The installer records MATRIX_RUNTIME_GROUP, but host
// helpers dropped privileges with --regid "$MATRIX_RUNTIME_USER", so developer
// tool installs failed and their unit kept retrying. Managed VPSes run as
// matrix:matrix and must behave exactly as before.
const hostBin = "distro/customer-vps/host-bin";
const read = (name: string) => readFileSync(join(hostBin, name), "utf8");

function functionSource(source: string, name: string): string {
  const definition = source.match(new RegExp(`\\n${name}\\(\\) \\{[\\s\\S]*?\\n\\}`))?.[0];
  if (!definition) throw new Error(`Missing function ${name}`);
  return definition;
}

function groupLine(source: string): string {
  const line = source.match(/^MATRIX_RUNTIME_GROUP=.*$/m)?.[0];
  if (!line) throw new Error("Missing MATRIX_RUNTIME_GROUP resolution");
  return line;
}

const STUBS = `
id() {
  case "$*" in
    "-gn alice") echo staff ;;
    "-gn matrix") echo matrix ;;
    "-gn ghost") return 1 ;;
    "-u") echo 0 ;;
    "-u -n"|"-un") echo root ;;
    *) command id "$@" ;;
  esac
}
setpriv() { printf 'setpriv %s\\n' "$*"; }
sudo() { printf 'sudo %s\\n' "$*"; }
timeout() { shift; "$@"; }
`;

function run(script: string, user: string, group: string | undefined, runner: string) {
  const source = read(script);
  const body = [
    STUBS,
    `MATRIX_RUNTIME_USER=${user}`,
    group === undefined ? "unset MATRIX_RUNTIME_GROUP" : `MATRIX_RUNTIME_GROUP=${group}`,
    "MATRIX_RUNTIME_HOME=/home/x NODE_PREFIX=/n",
    groupLine(source),
    `printf 'group=%s\\n' "$MATRIX_RUNTIME_GROUP"`,
    runner ? functionSource(source, runner) : "",
    runner ? `${runner} true` : "",
  ].join("\n");
  return spawnSync("bash", ["-c", body], { encoding: "utf8", timeout: 5_000 });
}

const RUNNERS: Array<[string, string]> = [
  ["matrix-install-tool-pack", "run_as_matrix"],
  ["matrix-install-hermes", "run_installer_as_runtime_user"],
  ["matrix-install-openclaw", "run_installer_as_runtime_user"],
  ["matrix-register-integrations-mcp", "run_as_runtime_user"],
  ["matrix-agent-runtime-control", ""],
];

describe.each(RUNNERS)("%s runtime group", (script, runner) => {
  it("uses the owner's primary group when it is not named after the account", () => {
    const result = run(script, "alice", undefined, runner);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("group=staff\n");
    if (runner) expect(result.stdout).toContain("setpriv --reuid alice --regid staff --init-groups");
  });

  it("uses the recorded MATRIX_RUNTIME_GROUP", () => {
    const result = run(script, "alice", "developers", runner);
    expect(result.stdout).toContain("group=developers\n");
    if (runner) expect(result.stdout).toContain("--regid developers");
  });

  it("keeps managed matrix:matrix unchanged", () => {
    const result = run(script, "matrix", undefined, runner);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("group=matrix\n");
    if (runner) expect(result.stdout).toContain("setpriv --reuid matrix --regid matrix --init-groups");
  });

  it("never guesses the account name as its group", () => {
    const result = run(script, "ghost", undefined, "");
    expect(result.stdout).toContain("group=\n");
  });
});

describe("host helpers", () => {
  it("never use the runtime account name as a group", () => {
    for (const name of readdirSync(hostBin)) {
      // Only helper scripts; local caches such as __pycache__ are not shipped.
      if (!statSync(join(hostBin, name)).isFile()) continue;
      const source = read(name);
      expect(source, name).not.toMatch(/--regid "\$\{?MATRIX_RUNTIME_USER/);
      expect(source, name).not.toMatch(/-g "\$\{?MATRIX_RUNTIME_USER/);
      expect(source, name).not.toMatch(/:\$\{?MATRIX_RUNTIME_USER\}?"/);
      expect(source, name).not.toMatch(/MATRIX_RUNTIME_GROUP:-\$\{?MATRIX_RUNTIME_USER\}?"/);
    }
  });
});

// Found in review (P2): the Hermes installer's owner-directory branch passed the
// account name as the group, so an owner alice whose primary group is staff (no
// group named alice) failed during directory creation.
describe("matrix-install-hermes owner directories", () => {
  it("creates the owner's directories with the runtime group, not the account name", () => {
    const hermes = read("matrix-install-hermes");
    const ownerEnv = read("matrix-owner-env");
    const branch = hermes.match(/\nif declare -F matrix_install_owner_dirs[\s\S]*?\nfi\n/)?.[0];
    if (!branch) throw new Error("Missing owner-directory branch");
    const body = [
      `id() { case "$*" in "-u") echo 0 ;; *) command id "$@" ;; esac; }`,
      // The real install(1) refuses a group that does not exist.
      `install() { local group=""; while [ $# -gt 0 ]; do case "$1" in -g) group="$2"; shift 2 ;; -o|-m) shift 2 ;; *) shift ;; esac; done; [ "$group" = staff ] || { echo "install: invalid group '$group'" >&2; return 1; }; printf 'install -g %s\\n' "$group"; }`,
      functionSource(ownerEnv, "matrix_install_dir"),
      functionSource(ownerEnv, "matrix_install_owner_dirs"),
      "MATRIX_RUNTIME_USER=alice MATRIX_RUNTIME_GROUP=staff MATRIX_HOME=/home/alice/matrix MATRIX_RUNTIME_HOME=/home/alice/matrix",
      "set -e",
      branch,
    ].join("\n");
    const result = spawnSync("bash", ["-c", body], { encoding: "utf8", timeout: 5_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("install -g staff");
    expect(result.stdout).not.toContain("install -g alice");
  });
});
