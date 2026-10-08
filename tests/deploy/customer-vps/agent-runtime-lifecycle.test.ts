import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  access,
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
function managedLauncher(home: string): string {
  return `#!/usr/bin/env bash\nunset PYTHONPATH\nunset PYTHONHOME\nexec "${home}/.hermes/hermes-agent/venv/bin/python" "${home}/.hermes/hermes-agent/hermes" "$@"\n`;
}
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
  await writeFile(join(home, ".local/bin/hermes"), managedLauncher(home));
  await chmod(join(home, ".local/bin/hermes"), 0o755);
  const log = join(root, "calls");
  const mocks: Record<string, string> = {
    id: "echo 0",
    install: 'while [ "$#" -gt 1 ]; do shift; done; mkdir -p "$1"',
    chown: "exit 0",
    flock: `printf 'flock %s\\n' "$*" >>"$CALLS"
exec python3 - "$@" <<'PYLOCK'
import fcntl, sys, time
fd = int(sys.argv[-1])
deadline = time.monotonic() + (float(sys.argv[2]) if sys.argv[1] == '-w' else 0)
while True:
  try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    sys.exit(0)
  except BlockingIOError:
    if time.monotonic() >= deadline: sys.exit(1)
    time.sleep(0.01)
PYLOCK`,
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
it("stops the installer before fencing cancellation with its control lock", async () => {
  const f = await fixture();
  await run("bash", [f.script, "cancel-install", "hermes"], { env: f.env });
  const calls = await readFile(f.log, "utf8");
  expect(calls).toContain("systemctl stop matrix-agent-install-hermes.service");
  expect(calls.indexOf("systemctl stop matrix-agent-install-hermes.service")).toBeLessThan(calls.indexOf("flock"));
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
    "unset PYTHONPATH",
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

it("retains an owner-customized Hermes launcher and reports incomplete uninstall", async () => {
  const f = await fixture();
  const customized = "#!/bin/sh\n# owner custom launcher\nexit 0\n";
  await writeFile(join(f.home, ".local/bin/hermes"), customized);
  await expect(run("bash", [f.script, "uninstall", "hermes"], { env: f.env })).rejects.toMatchObject({ code: 5 });
  expect(await readFile(join(f.home, ".local/bin/hermes"), "utf8")).toBe(customized);
  expect(await readFile(join(f.state, "disabled-hermes"), "utf8")).toBe("disabled\n");
});

it("keeps repeated concurrent uninstall opt-outs idempotent without following marker symlinks", async () => {
  const f = await fixture();
  // Launcher validation/removal belongs under the same cross-process lock.
  // Delaying comparison makes a logging-only flock stub's false concurrency deterministic.
  await writeFile(join(f.root, "tools/cmp"), `#!/bin/bash
mkdir "$MATRIX_RUNTIME_HOME/compare-active" || exit 70
trap 'rmdir "$MATRIX_RUNTIME_HOME/compare-active"' EXIT
sleep 0.2
/usr/bin/cmp "$@"
`);
  await chmod(join(f.root, "tools/cmp"), 0o755);
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => run("bash", [f.script, "uninstall", "hermes"], { env: f.env })));
  expect(results.filter(result => result.status === "rejected")).toEqual([]);
  expect(results.every(result => result.status === "fulfilled")).toBe(true);
  expect(await readFile(join(f.state, "disabled-hermes"), "utf8")).toBe("disabled\n");
  await rm(join(f.state, "disabled-hermes"));
  await symlink(join(f.home, "chats/thread"), join(f.state, "disabled-hermes"));
  await expect(run("bash", [f.script, "uninstall", "hermes"], { env: f.env })).rejects.toMatchObject({ code: 5 });
  expect(await readFile(join(f.home, "chats/thread"), "utf8")).toBe("owner-chat");
});

it("does not report cancellation before a delayed installer unit is visible and stopped", async () => {
  const f = await fixture();
  await rm(join(f.home, ".local/bin/hermes"));
  await mkdir(join(f.root, "host/bin"), { recursive: true });
  await writeFile(join(f.root, "host/bin/matrix-install-hermes"), "#!/bin/sh\nexit 0\n");
  await chmod(join(f.root, "host/bin/matrix-install-hermes"), 0o755);
  await writeFile(join(f.root, "tools/flock"), `#!/usr/bin/env python3
import fcntl, sys, time
fd = int(sys.argv[-1])
deadline = time.monotonic() + (float(sys.argv[2]) if sys.argv[1] == '-w' else 0)
while True:
  try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    sys.exit(0)
  except BlockingIOError:
    if time.monotonic() >= deadline: sys.exit(1)
    time.sleep(0.01)
`);
  await writeFile(join(f.root, "tools/systemd-run"), `#!/bin/bash
: > "$RACE_ROOT/entered"
while [ ! -f "$RACE_ROOT/release" ]; do sleep 0.01; done
: > "$RACE_ROOT/loaded"
while [ ! -f "$RACE_ROOT/stopped" ]; do sleep 0.01; done
exit 1
`);
  await writeFile(join(f.root, "tools/systemctl"), `#!/bin/bash
if [ "$1" = show ]; then
  if [ -f "$RACE_ROOT/loaded" ]; then echo loaded; else : > "$RACE_ROOT/checked-not-found"; echo not-found; fi
elif [ "$1" = stop ] && [ "$2" = matrix-agent-install-hermes.service ] && [ -f "$RACE_ROOT/loaded" ]; then
  : > "$RACE_ROOT/stopped"
fi
`);
  const env = { ...f.env, RACE_ROOT: f.root };
  const installing = run("bash", [f.script, "install", "hermes"], { env });
  let installFailure: Error | undefined;
  const installed = installing.then(() => "success", error => { installFailure = error; return "failed"; });
  const deadline = Date.now() + 10_000;
  while (await access(join(f.root, "entered")).then(() => false, () => true)) {
    if (installFailure) throw installFailure;
    if (Date.now() > deadline) throw new Error("installer fixture did not start");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  let settled = false;
  const cancellation = run("bash", [f.script, "cancel-install", "hermes"], { env }).then(result => { settled = true; return result; });
  let launchWasFenced = false;
  try {
    const checkedDeadline = Date.now() + 5000;
    while (await access(join(f.root, "checked-not-found")).then(() => false, () => true)) {
      if (Date.now() > checkedDeadline) throw new Error("cancellation fixture did not check unit");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(settled).toBe(false);
    launchWasFenced = true;
  } finally {
    await writeFile(join(f.root, "release"), "");
    if (!launchWasFenced) {
      await writeFile(join(f.root, "stopped"), "");
      await installed;
      await cancellation.catch(error => { expect(error).toBeInstanceOf(Error); });
    }
  }
  expect(JSON.parse((await cancellation).stdout)).toMatchObject({ cancelled: true });
  expect(await installed).toBe("failed");
  await access(join(f.root, "stopped"));
  await expect(access(join(f.state, "disabled-hermes"))).rejects.toMatchObject({ code: "ENOENT" });
}, 30_000);

it("fails cancellation within its deadline when installer admission cannot drain", async () => {
  const f = await fixture();
  await writeFile(f.script, (await readFile(f.script, "utf8")).replace(/cancel_timeout_seconds=\d+/, "cancel_timeout_seconds=1"));
  await writeFile(join(f.root, "tools/flock"), "#!/bin/sh\nexit 1\n");
  await expect(run("bash", [f.script, "cancel-install", "hermes"], { env: f.env, timeout: 5000 })).rejects.toMatchObject({ code: 5 });
});

it("retains an unproven launcher symlink without deleting its owner target", async () => {
  const f = await fixture();
  await rm(join(f.home, ".local/bin/hermes"));
  await symlink(join(f.home, "chats/thread"), join(f.home, ".local/bin/hermes"));
  await expect(run("bash", [f.script, "uninstall", "hermes"], { env: f.env })).rejects.toMatchObject({ code: 5 });
  expect(await readFile(join(f.home, ".local/bin/hermes"), "utf8")).toBe("owner-chat");
  expect(await readFile(join(f.home, "chats/thread"), "utf8")).toBe("owner-chat");
});

it("removes the exact legacy managed launcher symlink while retaining the venv entrypoint", async () => {
  const f = await fixture();
  const target = join(f.home, ".hermes/hermes-agent/venv/bin/hermes");
  await mkdir(join(f.home, ".hermes/hermes-agent/venv/bin"), { recursive: true });
  await writeFile(target, "legacy managed entrypoint");
  await rm(join(f.home, ".local/bin/hermes"));
  await symlink(target, join(f.home, ".local/bin/hermes"));
  await run("bash", [f.script, "uninstall", "hermes"], { env: f.env });
  await expect(access(join(f.home, ".local/bin/hermes"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(target, "utf8")).toBe("legacy managed entrypoint");
});
