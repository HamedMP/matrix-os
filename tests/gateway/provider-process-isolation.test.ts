import { describe, expect, it, vi } from "vitest";
import {
  buildIsolatedProviderLaunch,
  cleanupStaleIsolatedProviderProcesses,
  probeProviderScopeClosed,
  spawnIsolatedProviderProcess,
} from "../../packages/gateway/src/coding-agents/provider-process-isolation.js";

describe("provider process isolation", () => {
  it("moves production CLI work into the bounded user-systemd workload slice", () => {
    const launch = buildIsolatedProviderLaunch({
      command: "opencode",
      args: ["run", "inspect the repository"],
      env: { HOME: "/home/matrix/home", PATH: "/opt/matrix/runtime/node/bin" },
    }, {
      platform: "linux",
      uid: 1001,
      unitName: "matrix-chat-provider-0123456789abcdef0123456789abcdef",
      pathExists: vi.fn(() => true),
    });

    expect(launch).toEqual({
      command: "/usr/bin/systemd-run",
      args: [
        "--user",
        "--scope",
        "--quiet",
        "--collect",
        "--unit=matrix-chat-provider-0123456789abcdef0123456789abcdef",
        "--slice=matrix-terminal.slice",
        "--property=MemoryHigh=1G",
        "--property=MemoryMax=1536M",
        "--property=TasksMax=1024",
        "--",
        "opencode",
        "run",
        "inspect the repository",
      ],
      env: {
        HOME: "/home/matrix/home",
        PATH: "/opt/matrix/runtime/node/bin",
        XDG_RUNTIME_DIR: "/run/user/1001",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1001/bus",
      },
      isolated: true,
      unitName: "matrix-chat-provider-0123456789abcdef0123456789abcdef",
    });
  });

  it("stops only bounded stale canonical Chat provider scopes at startup", async () => {
    const runCommand = vi.fn()
      .mockResolvedValueOnce({
        stdout: [
          "matrix-chat-provider-0123456789abcdef0123456789abcdef.scope loaded active running provider",
          "run-user-terminal.scope loaded active running terminal",
          "matrix-chat-provider-invalid.scope loaded active running provider",
        ].join("\n"),
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    await expect(cleanupStaleIsolatedProviderProcesses({
      platform: "linux",
      uid: 1001,
      pathExists: vi.fn(() => true),
      runCommand,
    })).resolves.toBe(1);

    expect(runCommand).toHaveBeenNthCalledWith(1,
      "/usr/bin/systemctl",
      ["--user", "list-units", "matrix-chat-provider-*.scope", "--all", "--no-legend", "--plain"],
      expect.objectContaining({
        env: expect.objectContaining({
          XDG_RUNTIME_DIR: "/run/user/1001",
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1001/bus",
        }),
        timeout: 5_000,
      }),
    );
    expect(runCommand).toHaveBeenNthCalledWith(2,
      "/usr/bin/systemctl",
      ["--user", "stop", "matrix-chat-provider-0123456789abcdef0123456789abcdef.scope"],
      expect.objectContaining({ timeout: 5_000 }),
    );
  });

  it("keeps local and incomplete user-systemd environments on direct spawn", () => {
    const direct = buildIsolatedProviderLaunch({
      command: "pi",
      args: ["--mode", "json"],
      env: { HOME: "/tmp/matrix-home" },
    }, {
      platform: "darwin",
      uid: 501,
      pathExists: vi.fn(() => false),
    });
    expect(direct).toEqual({
      command: "pi",
      args: ["--mode", "json"],
      env: { HOME: "/tmp/matrix-home" },
      isolated: false,
    });

    const missingBus = buildIsolatedProviderLaunch({
      command: "claude",
      args: ["--print"],
      env: { HOME: "/home/matrix/home" },
    }, {
      platform: "linux",
      uid: 1001,
      pathExists: vi.fn((path) => path !== "/run/user/1001/bus"),
    });
    expect(missingBus.isolated).toBe(false);
    expect(missingBus.command).toBe("claude");
  });

  it("refuses a required scope instead of falling back to a direct process", () => {
    vi.stubEnv("MATRIX_PROVIDER_PROCESS_ISOLATION", "0");
    try {
      expect(() => spawnIsolatedProviderProcess(process.execPath, ["--version"], {
        cwd: process.cwd(), env: {}, stdio: ["pipe", "pipe", "pipe", "pipe"], requireIsolation: true,
      })).toThrow("Provider process isolation unavailable");
    } finally { vi.unstubAllEnvs(); }
  });

  const unitName = "matrix-chat-provider-0123456789abcdef0123456789abcdef";
  const root = "/sys/fs/cgroup/user.slice/user-1001.slice/user@1001.service";
  const scope = `${root}/matrix.slice/matrix-terminal.slice/${unitName}.scope`;

  function closureProbe(properties: string, events: string | Error, parent = "populated 1\n") {
    const runCommand = vi.fn(async () => ({
      stdout: `Id=${unitName}.scope\n${properties}`,
      stderr: "",
    }));
    const readEvents = vi.fn(async (path: string) => {
      if (path === `${root}/cgroup.events`) return parent;
      if (path !== `${scope}/cgroup.events`) throw new Error("unexpected cgroup");
      if (events instanceof Error) throw events;
      return events;
    });
    return probeProviderScopeClosed({ unitName, uid: 1001 }, { runCommand, readEvents });
  }

  it("confirms a dead owned scope only after the cgroup subtree is drained", async () => {
    const dead = `LoadState=loaded\nActiveState=inactive\nSubState=dead\nSlice=matrix-terminal.slice\nControlGroup=${scope.slice("/sys/fs/cgroup".length)}\n`;
    await expect(closureProbe(dead, "populated 0\nfrozen 0\n")).resolves.toBe(true);
    await expect(closureProbe(dead, "populated 1\nfrozen 0\n")).resolves.toBe(false);
    await expect(closureProbe(dead.replace("ActiveState=inactive", "ActiveState=deactivating"), "populated 0\n")).resolves.toBe(false);
    await expect(closureProbe(dead.replace("/matrix.slice/", "/other.slice/"), "populated 0\n")).resolves.toBe(false);
  });

  it("distinguishes collection from an unreadable or mismatched cgroup", async () => {
    const collected = "LoadState=not-found\nActiveState=inactive\nSubState=dead\nSlice=\nControlGroup=\n";
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    await expect(closureProbe(collected, missing)).resolves.toBe(true);
    await expect(closureProbe(collected, missing, "unknown\n")).resolves.toBe(false);
    await expect(closureProbe(collected, "populated 1\n")).resolves.toBe(false);
    await expect(closureProbe(collected, Object.assign(new Error("permission"), { code: "EACCES" }))).resolves.toBe(false);
  });
});

// Actual credential-free Node descriptor fixture, not systemd or native OpenCode qualification.
it.each(["ignore", "pipe"] as const)("preserves the fourth owned descriptor with %s stdin through the real direct provider spawn helper", async stdin => {
  const { spawnIsolatedProviderProcess } = await import("../../packages/gateway/src/coding-agents/provider-process-isolation.js");
  const { once } = await import("node:events");
  vi.stubEnv("MATRIX_PROVIDER_PROCESS_ISOLATION", "0");
  const args = ["--input-type=module", "-e", "import { writeSync } from 'node:fs'; writeSync(3, 'owned-descriptor');"];
  const options = { cwd: process.cwd(), env: { PATH: process.env.PATH ?? "" } };
  const child = stdin === "ignore"
    ? spawnIsolatedProviderProcess(process.execPath, args, { ...options, stdio: ["ignore", "pipe", "pipe", "pipe"] })
    : spawnIsolatedProviderProcess(process.execPath, args, { ...options, stdio: ["pipe", "pipe", "pipe", "pipe"] });
  try {
    const pipe = (child.stdio as unknown as import("node:stream").Duplex[])[3];
    if (!pipe) throw new Error("Missing owned descriptor");
    let received = ""; pipe.on("data", (chunk: Buffer) => { received += chunk.toString("utf8"); });
    expect((await once(child, "close"))[0]).toBe(0);
    expect(received).toBe("owned-descriptor");
  } finally { child.kill("SIGKILL"); vi.unstubAllEnvs(); }
});
