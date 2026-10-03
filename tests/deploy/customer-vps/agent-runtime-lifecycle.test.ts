import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "matrix-lifecycle-"));
  roots.push(root);
  const tools = join(root, "tools");
  const home = join(root, "owner");
  const prefix = join(root, "node");
  const state = join(root, "state");
  await mkdir(tools);
  await mkdir(join(home, ".local/bin"), { recursive: true });
  await mkdir(join(prefix, "bin"), { recursive: true });
  await mkdir(join(home, ".hermes"));
  await writeFile(join(home, ".hermes/config.yaml"), "owner-profile");
  await mkdir(join(home, "chats"));
  await writeFile(join(home, "chats/thread"), "owner-chat");
  await writeFile(join(home, ".local/bin/hermes"), "#!/bin/sh\nexit 0\n");
  await chmod(join(home, ".local/bin/hermes"), 0o755);
  const log = join(root, "calls");
  const mocks: Record<string, string> = {
    id: "echo 0",
    install: 'while [ "$#" -gt 1 ]; do shift; done; mkdir -p "$1"',
    chown: "exit 0",
    flock: 'printf "flock %s\\n" "$*" >>"$CALLS"',
    timeout: 'shift; exec "$@"',
    systemctl:
      'printf "systemctl %s\\n" "$*" >>"$CALLS"; [ "${STOP_FAILURE:-}" != yes ]',
    "systemd-run":
      'printf "systemd-run %s\\n" "$*" >>"$CALLS"; touch "$MATRIX_RUNTIME_HOME/.local/bin/hermes"; chmod +x "$MATRIX_RUNTIME_HOME/.local/bin/hermes"',
    setpriv: 'printf "setpriv %s\\n" "$*" >>"$CALLS"; shift 5; exec "$@"',
    sudo: "exit 99",
  };
  for (const [name, body] of Object.entries(mocks)) {
    await writeFile(join(tools, name), `#!/bin/bash\n${body}\n`);
    await chmod(join(tools, name), 0o755);
  }
  const script = join(root, "control");
  let source = await readFile(
    "distro/customer-vps/host-bin/matrix-agent-runtime-control",
    "utf8",
  );
  source = source
    .replaceAll("/opt/matrix", join(root, "host"))
    .replaceAll("/var/lib/matrix-agent-runtime", state)
    .replaceAll("/usr/local/bin/hermes", join(root, "global-hermes"));
  await writeFile(script, source);
  const env = {
    ...process.env,
    PATH: `${tools}:${process.env.PATH}`,
    MATRIX_RUNTIME_HOME: home,
    MATRIX_NODE_PREFIX: prefix,
    MATRIX_RUNTIME_USER: "test",
    CALLS: log,
  };
  return { root, home, prefix, state, log, script, env };
}
it("cancels the installer cgroup without waiting on the install lock", async () => {
  const f = await fixture();
  await run("bash", [f.script, "cancel-install", "hermes"], { env: f.env });
  const calls = await readFile(f.log, "utf8");
  expect(calls).toContain("systemctl stop matrix-agent-install-hermes.service");
  expect(calls).not.toContain("flock");
});
it("uninstalls the Hermes launcher while retaining owner data and a durable opt-out", async () => {
  const f = await fixture();
  await symlink(
    join(f.home, ".local/bin/hermes"),
    join(f.root, "global-hermes"),
  );
  await run("bash", [f.script, "uninstall", "hermes"], { env: f.env });
  await expect(
    readFile(join(f.home, ".local/bin/hermes")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(f.home, ".hermes/config.yaml"), "utf8")).toBe(
    "owner-profile",
  );
  expect(await readFile(join(f.home, "chats/thread"), "utf8")).toBe(
    "owner-chat",
  );
  expect(await readFile(join(f.state, "disabled-hermes"), "utf8")).toBe(
    "disabled\n",
  );
  const calls = await readFile(f.log, "utf8");
  expect(calls).toContain("disable --now matrix-hermes-dashboard.service");
});
it("fails safely if a service cannot be stopped", async () => {
  const f = await fixture();
  await expect(
    run("bash", [f.script, "uninstall", "hermes"], {
      env: { ...f.env, STOP_FAILURE: "yes" },
    }),
  ).rejects.toMatchObject({ code: 5 });
  expect(await readFile(join(f.home, ".local/bin/hermes"), "utf8")).toContain(
    "exit 0",
  );
});
it("uninstalls only the fixed OpenClaw package as the owner without lifecycle scripts", async () => {
  const f = await fixture();
  await writeFile(join(f.prefix, "bin/npm"), "#!/bin/sh\nexit 0");
  await chmod(join(f.prefix, "bin/npm"), 0o755);
  await run("bash", [f.script, "uninstall", "openclaw"], { env: f.env });
  const calls = await readFile(f.log, "utf8");
  expect(calls).toContain("setpriv --reuid test --regid test --init-groups");
  expect(calls).toContain(
    `uninstall --global --ignore-scripts --prefix ${f.prefix} openclaw`,
  );
  expect(await readFile(join(f.home, "chats/thread"), "utf8")).toBe(
    "owner-chat",
  );
});
it("rejects extra arguments and arbitrary runtime names before privileged work", async () => {
  const f = await fixture();
  for (const args of [
    ["uninstall", "../../owner"],
    ["cancel-install", "hermes", "extra"],
  ])
    await expect(
      run("bash", [f.script, ...args], { env: f.env }),
    ).rejects.toMatchObject({ code: 2 });
  await expect(readFile(f.log)).rejects.toMatchObject({ code: "ENOENT" });
});
it("explicit installation clears opt-out and runs one bounded, visible cgroup", async () => {
  const f = await fixture();
  await mkdir(f.state);
  await writeFile(join(f.state, "disabled-hermes"), "disabled\n");
  await rm(join(f.home, ".local/bin/hermes"));
  await mkdir(join(f.root, "host/bin"), { recursive: true });
  await writeFile(
    join(f.root, "host/bin/matrix-install-hermes"),
    "#!/bin/sh\nexit 0\n",
  );
  await chmod(join(f.root, "host/bin/matrix-install-hermes"), 0o755);
  await run("bash", [f.script, "install", "hermes"], { env: f.env });
  await expect(
    readFile(join(f.state, "disabled-hermes")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  const calls = await readFile(f.log, "utf8");
  expect(calls).toContain(
    "systemd-run --unit=matrix-agent-install-hermes --wait --pipe --collect --service-type=exec --property=KillMode=control-group --property=RuntimeMaxSec=1810 --property=TimeoutStopSec=15",
  );
});
it("automatic installers and release reconciliation honor durable opt-outs", async () => {
  for (const kind of ["hermes", "openclaw"]) {
    const source = await readFile(
      `distro/customer-vps/host-bin/matrix-install-${kind}`,
      "utf8",
    );
    expect(source).toContain(`/var/lib/matrix-agent-runtime/disabled-${kind}`);
  }
  const sync = await readFile(
    "distro/customer-vps/host-bin/matrix-sync-agent",
    "utf8",
  );
  expect(
    sync.indexOf("Hermes reconciliation skipped: owner disabled installation"),
  ).toBeLessThan(sync.indexOf("sudo systemctl enable matrix-hermes.service"));
  for (const [unit, kind] of [
    ["matrix-hermes.service", "hermes"],
    ["matrix-hermes-dashboard.service", "hermes"],
    ["matrix-openclaw-gateway.service", "openclaw"],
  ])
    expect(
      await readFile(`distro/customer-vps/systemd/${unit}`, "utf8"),
    ).toContain(
      `ConditionPathExists=!/var/lib/matrix-agent-runtime/disabled-${kind}`,
    );
});
