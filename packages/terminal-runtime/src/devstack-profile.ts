import { join } from "node:path";

const INSTANCE_PARENT = "/var/lib/matrix-devstack";
const RUNTIME_PARENT = "/run/matrix-devstack-terminal";
const DAEMON_UNIT = "matrix-devstack-terminal-runtime.service";
const VENDOR_USER_UNITS = "/usr/lib/systemd/user";
const SYSTEM_PATH = "/usr/bin:/bin";

export const DEVSTACK_TERMINAL_CONTROLLERS = ["cpu", "memory", "pids"];
export const DEVSTACK_TERMINAL_LIMITS = {
  manager: { cpuPercent: 200, memoryMiB: 1024, tasks: 768 },
  aggregate: { cpuPercent: 150, memoryMiB: 768, tasks: 512 },
};
export const DEVSTACK_TERMINAL_MASKED_PATHS = [
  "/opt/matrix", "/etc/matrix", "/var/lib/matrix", "/var/lib/matrix-agent-runtime",
  "/var/lib/matrix-developer-tools", "/var/lib/matrix-funded-host-config", "/var/lib/matrix-messaging",
  "/var/lib/matrix-support", "/var/lib/matrix-vps-registration",
  "/run/matrix", "/run/matrix-browser-preview", "/run/matrix-browser-runtime", "/run/matrix-devstack",
  "/run/docker.sock", "/run/docker", "/run/containerd", "/run/podman",
  "/run/systemd/private", "/run/dbus/system_bus_socket", "/run/user",
];

export function createDevStackTerminalProfile(namespace: string, account: string) {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(namespace)) {
    throw new Error("terminal_profile_namespace_invalid");
  }
  if (!/^mds-[a-z0-9](?:[a-z0-9-]{0,26}[a-z0-9])?$/.test(account)) {
    throw new Error("terminal_profile_account_invalid");
  }
  const instanceRoot = join(INSTANCE_PARENT, namespace);
  const homePath = join(instanceRoot, "home");
  const appDir = join(instanceRoot, "app");
  const nodePrefix = join(instanceRoot, "runtime", "node");
  const terminalRuntimeRoot = join(instanceRoot, "terminal-runtime");
  const runtimeDirectory = join(RUNTIME_PARENT, namespace);
  const socketDirectory = join(runtimeDirectory, "terminal");
  const zellijSocketRoot = join(runtimeDirectory, "zellij");
  const managerUnit = "matrix-devstack-" + namespace + "-terminal-user-manager.service";
  const managerControlGroup = "/system.slice/" + managerUnit;
  const matrixSlice = managerControlGroup + "/matrix.slice";
  return {
    namespace, account, instanceRoot, homePath, appDir, nodePrefix, terminalRuntimeRoot,
    runtimeDirectory, socketDirectory, zellijSocketRoot, managerUnit, managerControlGroup,
    nodeBinary: join(nodePrefix, "bin", "node"),
    daemonEntrypoint: join(appDir, "packages", "terminal-runtime", "dist", "service.js"),
    userUnitRoot: join(terminalRuntimeRoot, "user-units"),
    generationLockHelperPath: join(terminalRuntimeRoot, "matrix-terminal-generation-gc.py"),
    socketPath: join(socketDirectory, "terminal-runtime.sock"),
    managerBus: join(runtimeDirectory, "bus"),
    daemonUnit: DAEMON_UNIT,
    daemonControlGroup: matrixSlice + "/" + DAEMON_UNIT,
    cgroupRoot: "/sys/fs/cgroup" + matrixSlice + "/matrix-terminal.slice",
    // Zellij appends its protocol directory and session name to the socket path.
    // This bind alias exists only in the delegated manager's mount namespace.
    zellijSocketAlias: "/mnt",
  };
}

export type DevStackTerminalProfile = ReturnType<typeof createDevStackTerminalProfile>;

function managerEnvironment(profile: DevStackTerminalProfile) {
  return {
    HOME: profile.homePath,
    USER: profile.account,
    LOGNAME: profile.account,
    XDG_RUNTIME_DIR: profile.runtimeDirectory,
    DBUS_SESSION_BUS_ADDRESS: "unix:path=" + profile.managerBus,
    SYSTEMD_UNIT_PATH: profile.userUnitRoot + ":" + VENDOR_USER_UNITS,
    LANG: "C.UTF-8",
    PATH: SYSTEM_PATH,
  };
}

export function devStackDaemonEnvironment(profile: DevStackTerminalProfile): Record<string, string> {
  return {
    ...managerEnvironment(profile),
    NODE_ENV: "production",
    MATRIX_TERMINAL_RUNTIME_NAMESPACE: profile.namespace,
    MATRIX_HOME: profile.homePath,
    MATRIX_APP_DIR: profile.appDir,
    MATRIX_NODE_BIN: profile.nodeBinary,
    MATRIX_NODE_PREFIX: profile.nodePrefix,
    MATRIX_TERMINAL_RUNTIME_ROOT: profile.terminalRuntimeRoot,
    MATRIX_TERMINAL_RUNTIME_SOCKET: profile.socketPath,
    XDG_CONFIG_HOME: join(profile.homePath, ".config"),
    XDG_DATA_HOME: join(profile.homePath, ".local", "share"),
    XDG_CACHE_HOME: join(profile.homePath, ".cache"),
    ZELLIJ_CONFIG_DIR: join(profile.homePath, "system", "zellij"),
    ZELLIJ_SOCKET_DIR: profile.zellijSocketAlias,
    SHELL: "/bin/bash",
    PATH: join(profile.nodePrefix, "bin") + ":" + SYSTEM_PATH,
  };
}

export function renderPrivateTerminalUnits(profile: DevStackTerminalProfile) {
  const environment = Object.entries(devStackDaemonEnvironment(profile))
    .map(([key, value]) => "Environment=" + key + "=" + value);
  const { aggregate } = DEVSTACK_TERMINAL_LIMITS;
  const cleanExecEnvironment = "UnsetEnvironment=NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT"
    + " BASH_ENV ENV PYTHONPATH PYTHONHOME";
  function unit(lines: string[]): string {
    return lines.join("\n") + "\n";
  }
  return {
    "default.target": unit([
      "[Unit]",
      "Description=Isolated DevStack Terminal user manager",
      "DefaultDependencies=no",
      "Wants=dbus.socket",
      "After=dbus.socket",
    ]),
    "matrix-zellij@.service": unit([
      "[Unit]",
      "Description=Isolated DevStack Terminal session %i",
      "ConditionPathExists=" + join(profile.homePath, "system", "terminal-runtimes", "%i.json"),
      "",
      "[Service]",
      "Type=exec",
      ...environment,
      cleanExecEnvironment,
      "ExecStart=" + profile.nodeBinary + " "
        + join(profile.terminalRuntimeRoot, "current", "matrix-terminal-user-keeper.mjs") + " %i",
      "Slice=matrix-terminal.slice",
      "KillMode=control-group",
      "Restart=no",
      "TimeoutStartSec=15",
      "TimeoutStopSec=10",
      "TasksAccounting=yes",
      "TasksMax=192",
      "MemoryAccounting=yes",
      "MemoryHigh=128M",
      "MemoryMax=256M",
    ]),
    "matrix-terminal.slice": unit([
      "[Unit]",
      "Description=Isolated DevStack Terminal aggregate capacity",
      "",
      "[Slice]",
      "CPUAccounting=yes",
      "CPUQuota=" + aggregate.cpuPercent + "%",
      "MemoryAccounting=yes",
      "MemoryHigh=512M",
      "MemoryMax=" + aggregate.memoryMiB + "M",
      "TasksAccounting=yes",
      "TasksMax=" + aggregate.tasks,
    ]),
    [DAEMON_UNIT]: unit([
      "[Unit]",
      "Description=Isolated DevStack Terminal control plane",
      "Requires=dbus.socket matrix-terminal.slice",
      "After=dbus.socket matrix-terminal.slice",
      "",
      "[Service]",
      "Type=exec",
      ...environment,
      cleanExecEnvironment,
      "WorkingDirectory=" + profile.appDir,
      "ExecStart=" + profile.nodeBinary + " " + profile.daemonEntrypoint,
      "Slice=matrix.slice",
      "KillMode=control-group",
      "Restart=no",
      "TimeoutStopSec=30",
      "TasksMax=96",
      "MemoryMax=256M",
    ]),
  };
}

export function renderDevStackTerminalProfile(namespace: string, account: string) {
  const profile = createDevStackTerminalProfile(namespace, account);
  const { manager } = DEVSTACK_TERMINAL_LIMITS;
  const runtimeName = "matrix-devstack-terminal/" + profile.namespace;
  return {
    profile,
    manager: {
      unit: profile.managerUnit,
      command: ["/usr/lib/systemd/systemd", "--user"],
      environment: managerEnvironment(profile),
      properties: [
        "Type=notify",
        "NotifyAccess=main",
        "User=" + profile.account,
        "Group=" + profile.account,
        "Delegate=" + DEVSTACK_TERMINAL_CONTROLLERS.join(" "),
        "WorkingDirectory=" + profile.homePath,
        "RuntimeDirectory=" + runtimeName + " " + runtimeName + "/terminal " + runtimeName + "/zellij",
        "RuntimeDirectoryMode=0700",
        "MemoryMax=" + manager.memoryMiB + "M",
        "MemorySwapMax=0",
        "CPUQuota=" + manager.cpuPercent + "%",
        "TasksMax=" + manager.tasks,
        "RuntimeMaxSec=1800",
        "TimeoutStartSec=20",
        "TimeoutStopSec=40",
        "Restart=no",
        "PrivateNetwork=yes",
        "PrivateIPC=yes",
        "PrivateTmp=yes",
        "PrivateDevices=yes",
        "ProtectSystem=strict",
        "ProtectHome=yes",
        "ProtectProc=invisible",
        "NoNewPrivileges=yes",
        "CapabilityBoundingSet=",
        "AmbientCapabilities=",
        "ProtectKernelModules=yes",
        "ProtectKernelTunables=yes",
        "ProtectKernelLogs=yes",
        "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
        // Hide peer instances, then expose just this instance with its HOME writable.
        "TemporaryFileSystem=" + INSTANCE_PARENT + ":ro,mode=0755",
        "BindReadOnlyPaths=" + profile.instanceRoot,
        "BindPaths=" + profile.homePath + " " + profile.zellijSocketRoot + ":" + profile.zellijSocketAlias,
        "InaccessiblePaths=" + DEVSTACK_TERMINAL_MASKED_PATHS.map(path => "-" + path).join(" "),
        "LimitCORE=0",
        "UMask=0077",
      ],
    },
    daemon: { unit: profile.daemonUnit, environment: devStackDaemonEnvironment(profile) },
    gateway: { socketDirectory: profile.socketDirectory, socketPath: profile.socketPath },
    userUnits: renderPrivateTerminalUnits(profile),
  };
}
