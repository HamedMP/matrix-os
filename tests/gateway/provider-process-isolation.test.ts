import { describe, expect, it, vi } from "vitest";
import { buildIsolatedProviderLaunch } from "../../packages/gateway/src/coding-agents/provider-process-isolation.js";

describe("provider process isolation", () => {
  it("moves production CLI work into the bounded user-systemd workload slice", () => {
    const launch = buildIsolatedProviderLaunch({
      command: "opencode",
      args: ["run", "inspect the repository"],
      env: { HOME: "/home/matrix/home", PATH: "/opt/matrix/runtime/node/bin" },
    }, {
      platform: "linux",
      uid: 1001,
      pathExists: vi.fn(() => true),
    });

    expect(launch).toEqual({
      command: "/usr/bin/systemd-run",
      args: [
        "--user",
        "--scope",
        "--quiet",
        "--collect",
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
    });
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
});
