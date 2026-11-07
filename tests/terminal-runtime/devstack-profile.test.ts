import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { renderDevStackTerminalProfile } from "../../packages/terminal-runtime/src/devstack-profile.js";
import {
  assertIsolatedTerminalProcess,
  assertPrivateTerminalUnitSelection,
  resolveTerminalRuntimeDeployment,
} from "../../packages/terminal-runtime/src/runtime-deployment.js";

const namespace = "eng432-term1";
const account = "mds-e432-term1";
const instance = "/var/lib/matrix-devstack/eng432-term1";
const runtime = "/run/matrix-devstack-terminal/eng432-term1";
const manager = "matrix-devstack-eng432-term1-terminal-user-manager.service";
const daemon = "matrix-devstack-terminal-runtime.service";
const cgroup = "/system.slice/" + manager + "/matrix.slice";
const unitRoot = instance + "/terminal-runtime/user-units";
const artifact = () => renderDevStackTerminalProfile(namespace, account);

describe("native DevStack Terminal configuration", () => {
  it("feeds stdout from the actual renderer CLI into the daemon's startup parser", async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [
      "--import=tsx", "packages/terminal-runtime/src/render-devstack-profile.ts", namespace, account,
    ], { timeout: 5_000 });
    const output = JSON.parse(stdout) as ReturnType<typeof artifact>;
    const deployment = resolveTerminalRuntimeDeployment(output.daemon.environment);
    expect(deployment).toMatchObject({
      mode: "isolated",
      profile: {
        homePath: instance + "/home",
        appDir: instance + "/app",
        nodeBinary: instance + "/runtime/node/bin/node",
        terminalRuntimeRoot: instance + "/terminal-runtime",
        userUnitRoot: unitRoot,
        generationLockHelperPath: instance + "/terminal-runtime/matrix-terminal-generation-gc.py",
        runtimeDirectory: runtime,
        cgroupRoot: "/sys/fs/cgroup" + cgroup + "/matrix-terminal.slice",
      },
    });
    expect(output.gateway).toEqual({
      socketDirectory: runtime + "/terminal",
      socketPath: runtime + "/terminal/terminal-runtime.sock",
    });
    expect(output.manager).toMatchObject({
      unit: manager, command: ["/usr/lib/systemd/systemd", "--user"],
      properties: expect.arrayContaining([
        "User=" + account, "Group=" + account, "Delegate=cpu memory pids",
        "PrivateNetwork=yes", "PrivateIPC=yes", "ProtectSystem=strict", "NoNewPrivileges=yes",
        "CapabilityBoundingSet=", "BindPaths=" + instance + "/home " + runtime + "/zellij:/mnt",
      ]),
      environment: {
        HOME: instance + "/home",
        SYSTEMD_UNIT_PATH: unitRoot + ":/usr/lib/systemd/user",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=" + runtime + "/bus",
      },
    });
    expect(output.manager.properties.find(item => item.startsWith("RuntimeMaxSec=")))
      .toMatch(/^RuntimeMaxSec=[1-9]\d*$/);
    expect(Object.keys(output.userUnits).sort()).toEqual([
      "default.target", daemon, "matrix-terminal.slice", "matrix-zellij@.service",
    ].sort());
    expect(output.userUnits["default.target"]).toMatch(/^Wants=dbus\.socket$/m);
    expect(output.userUnits["matrix-zellij@.service"]).toContain(
      "ExecStart=" + instance + "/runtime/node/bin/node "
      + instance + "/terminal-runtime/current/matrix-terminal-user-keeper.mjs %i",
    );
    expect(output.userUnits["matrix-zellij@.service"]).toContain("Slice=matrix-terminal.slice\n");
    expect(output.userUnits["matrix-terminal.slice"]).toMatch(/^TasksMax=[1-9]\d*$/m);
    expect(output.userUnits[daemon]).toContain("ExecStart=" + instance + "/runtime/node/bin/node "
      + instance + "/app/packages/terminal-runtime/dist/service.js");
    expect(Object.values(output.userUnits).join("\n")).not.toContain("/opt/matrix");
  });

  it("masks installed Matrix state and host control sockets from the native manager", () => {
    const masked = artifact().manager.properties.find(item => item.startsWith("InaccessiblePaths="))
      ?.slice("InaccessiblePaths=".length).split(" ");
    expect(masked).toEqual(expect.arrayContaining([
      "-/opt/matrix", "-/etc/matrix", "-/var/lib/matrix", "-/var/lib/matrix-messaging",
      "-/run/matrix", "-/run/matrix-devstack", "-/run/docker.sock", "-/run/containerd",
      "-/run/systemd/private", "-/run/dbus/system_bus_socket", "-/run/user",
    ]));
  });

  it("accommodates maximum-length namespaces without lengthening the actual Zellij socket address", () => {
    const output = renderDevStackTerminalProfile("a".repeat(32), account);
    expect(output.profile.zellijSocketRoot).toBe("/run/matrix-devstack-terminal/" + "a".repeat(32) + "/zellij");
    expect(Buffer.byteLength(output.daemon.environment.ZELLIJ_SOCKET_DIR
      + "/contract_version_1/matrix-rt_" + "b".repeat(32))).toBeLessThan(108);
    expect(Buffer.byteLength(output.gateway.socketPath)).toBeLessThan(108);
  });

  it.each(["", "BAD", "../peer", "a".repeat(33), "owner\nRuntimeMaxSec=infinity"])(
    "rejects namespace %j before rendering systemd input", (input) => {
      expect(() => renderDevStackTerminalProfile(input, account)).toThrow("terminal_profile_namespace_invalid");
    },
  );

  it.each(["matrix", "root", "mds-evil.service", "mds-\nUser=root"])(
    "rejects non-dedicated or unsafe account %j", (input) => {
      expect(() => renderDevStackTerminalProfile(namespace, input)).toThrow("terminal_profile_account_invalid");
    },
  );

  it.each([
    ["MATRIX_HOME", "/home/matrix/home"],
    ["MATRIX_APP_DIR", instance + "/app/../app"],
    ["MATRIX_TERMINAL_RUNTIME_ROOT", "/opt/matrix/terminal-runtime"],
    ["MATRIX_TERMINAL_RUNTIME_SOCKET", "/run/matrix/terminal-runtime.sock"],
    ["SYSTEMD_UNIT_PATH", "/etc/systemd/user:" + unitRoot],
    ["DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/996/bus"],
    ["XDG_RUNTIME_DIR", "/run/matrix-devstack-terminal/peer"],
    ["ZELLIJ_SOCKET_DIR", "/run/matrix-devstack-terminal/peer/zellij"],
    ["MATRIX_NODE_BIN", "/opt/matrix/runtime/node/bin/node"],
    ["XDG_CACHE_HOME", undefined],
  ])("rejects a foreign, non-canonical or partial %s", (key, value) => {
    expect(() => resolveTerminalRuntimeDeployment({ ...artifact().daemon.environment, [key]: value }))
      .toThrow("terminal_profile_environment_mismatch: " + key);
  });

  it("keeps the installed defaults and existing installed overrides when the namespace is unset", () => {
    expect(resolveTerminalRuntimeDeployment({})).toEqual({
      mode: "installed", homePath: "/home/matrix/home", appDir: "/opt/matrix/app",
      terminalRuntimeRoot: "/opt/matrix/terminal-runtime", socketPath: "/run/matrix/terminal-runtime.sock",
      generationLockHelperPath: "/opt/matrix/bin/matrix-terminal-generation-gc.py",
    });
    expect(resolveTerminalRuntimeDeployment({ HOME: "/srv/home", MATRIX_APP_DIR: "/srv/app",
      MATRIX_TERMINAL_RUNTIME_ROOT: "/srv/runtime", MATRIX_TERMINAL_RUNTIME_SOCKET: "/run/legacy.sock" }))
      .toMatchObject({ homePath: "/srv/home", appDir: "/srv/app",
        terminalRuntimeRoot: "/srv/runtime", socketPath: "/run/legacy.sock" });
    expect(() => resolveTerminalRuntimeDeployment({ MATRIX_TERMINAL_RUNTIME_NAMESPACE: "" }))
      .toThrow("terminal_profile_namespace_invalid");
  });

  it("passes only owned environment values to systemctl and Zellij", () => {
    const deployment = resolveTerminalRuntimeDeployment({
      ...artifact().daemon.environment, ANTHROPIC_API_KEY: "secret", NODE_OPTIONS: "--import=foreign",
      ZELLIJ_SESSION_NAME: "foreign-session", ZELLIJ_CONFIG_FILE: "/home/matrix/foreign.kdl",
    });
    if (deployment.mode !== "isolated") throw new Error("fixture requires isolated mode");
    expect(deployment.environment).toEqual(artifact().daemon.environment);
    expect(deployment.environment.PATH).toBe(
      instance + "/runtime/node/bin:/usr/bin:/bin",
    );
  });
});

describe("isolated daemon startup admission", () => {
  const identity = {
    platform: "linux", uid: 890, effectiveUid: 890, gid: 890, effectiveGid: 890, groups: [890],
    user: { uid: 890, gid: 890, username: account, homedir: instance + "/home", shell: "/usr/sbin/nologin" },
    groupName: account,
    execPath: instance + "/runtime/node/bin/node",
    networkDevices: "Inter-| Receive | Transmit\n face | bytes | bytes\n  lo: 0 0 0 0\n",
    cgroup: "0::" + cgroup + "/" + daemon + "\n",
    cgroupLimits: {
      delegatedControllers: "cpu memory pids\n",
      manager: { cpu: "200000 100000\n", memory: "1073741824\n", tasks: "768\n" },
      aggregate: { cpu: "150000 100000\n", memory: "805306368\n", tasks: "512\n" },
    },
    status: "CapBnd:\t0000000000000000\nCapEff:\t0000000000000000\nNoNewPrivs:\t1\n",
  };

  it("accepts only the dedicated auxiliary user running in the delegated daemon unit", () => {
    expect(() => assertIsolatedTerminalProcess(artifact().profile, identity)).not.toThrow();
  });

  it.each([
    { uid: 0 }, { effectiveUid: 996 }, { effectiveGid: 996 }, { groups: [890, 996] },
    { groupName: "docker" },
    { user: { ...identity.user, username: "matrix" } },
    { user: { ...identity.user, homedir: "/home/matrix/home" } },
    { user: { ...identity.user, shell: "/bin/bash" } },
    { execPath: "/opt/matrix/runtime/node/bin/node" },
    { cgroup: "0::/user.slice/user-890.slice/user@890.service/matrix.slice/" + daemon },
    { cgroup: identity.cgroup.replace(namespace, "peer") },
    { networkDevices: identity.networkDevices + "eth0: 0 0 0 0\n" },
    { networkDevices: "" },
    { status: identity.status.replace("NoNewPrivs:\t1", "NoNewPrivs:\t0") },
    { status: identity.status.replace("CapEff:\t0000000000000000", "CapEff:\t0000000000000001") },
  ])("fails closed for process placement mismatch %j", (overrides) => {
    expect(() => assertIsolatedTerminalProcess(artifact().profile, { ...identity, ...overrides }))
      .toThrow(/terminal_profile_(identity|placement)_invalid/);
  });

  it.each([
    { delegatedControllers: "cpu memory\n" },
    { manager: { ...identity.cgroupLimits.manager, memory: "max\n" } },
    { aggregate: { ...identity.cgroupLimits.aggregate, cpu: "max 100000\n" } },
    { aggregate: { ...identity.cgroupLimits.aggregate, tasks: "max\n" } },
  ])("rejects missing or ineffective kernel resource controls %j", (limits) => {
    expect(() => assertIsolatedTerminalProcess(artifact().profile, {
      ...identity,
      cgroupLimits: { ...identity.cgroupLimits, ...limits },
    })).toThrow("terminal_profile_placement_invalid");
  });

  function unitShow(unit: string): string {
    const template = unit.startsWith("matrix-zellij@");
    const fragment = unitRoot + "/" + (template ? "matrix-zellij@.service" : unit);
    const slice = template ? "matrix-terminal.slice" : unit === daemon ? "matrix.slice" : "";
    return [
      "LoadState=loaded", "NeedDaemonReload=no", "DropInPaths=", "FragmentPath=" + fragment,
      "Slice=" + slice, "ControlGroup=" + (unit === daemon ? cgroup + "/" + daemon : ""),
    ].join("\n") + "\n";
  }

  it("accepts effective loaded definitions from the generated owned unit root", async () => {
    const queried: string[] = [];
    await expect(assertPrivateTerminalUnitSelection(artifact().profile, async (unit) => {
      queried.push(unit);
      return unitShow(unit);
    })).resolves.toBeUndefined();
    expect(queried).toEqual(expect.arrayContaining([
      expect.stringMatching(/^matrix-zellij@rt_[0-9a-f]{32}\.service$/), "matrix-terminal.slice", daemon,
    ]));
  });

  it.each([
    ["matrix-zellij@", "FragmentPath=", "FragmentPath=/etc/systemd/user/"],
    ["matrix-zellij@", "Slice=matrix-terminal.slice", "Slice=app.slice"],
    ["matrix-terminal.slice", "DropInPaths=\n", "DropInPaths=/etc/systemd/user/override.conf\n"],
    ["matrix-terminal.slice", "NeedDaemonReload=no", "NeedDaemonReload=yes"],
    [daemon, "LoadState=loaded", "LoadState=not-found"],
    [daemon, "ControlGroup=" + cgroup, "ControlGroup=/user.slice"],
  ])("rejects wrong effective definition for %s (%s)", async (target, from, to) => {
    await expect(assertPrivateTerminalUnitSelection(artifact().profile, async (unit) =>
      unit.startsWith(target) ? unitShow(unit).replace(from, to) : unitShow(unit)))
      .rejects.toThrow("terminal_profile_unit_mismatch");
  });
});
