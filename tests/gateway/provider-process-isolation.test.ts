import { describe, expect, it, vi } from "vitest";
import {
  buildIsolatedProviderLaunch,
  cleanupStaleIsolatedProviderProcesses,
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
});

// Actual credential-free Node descriptor fixture, not systemd or native OpenCode qualification.
it("preserves the fourth owned descriptor through the real direct provider spawn helper", async () => {
  const { spawnIsolatedProviderProcess } = await import("../../packages/gateway/src/coding-agents/provider-process-isolation.js");
  const { once } = await import("node:events");
  vi.stubEnv("MATRIX_PROVIDER_PROCESS_ISOLATION", "0");
  const child = spawnIsolatedProviderProcess(process.execPath, ["--input-type=module", "-e", "import { writeSync } from 'node:fs'; writeSync(3, 'owned-descriptor');"], {
    cwd: process.cwd(), env: { PATH: process.env.PATH ?? "" }, stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  try {
    const pipe = (child.stdio as unknown as import("node:stream").Duplex[])[3];
    if (!pipe) throw new Error("Missing owned descriptor");
    let received = ""; pipe.on("data", (chunk: Buffer) => { received += chunk.toString("utf8"); });
    expect((await once(child, "close"))[0]).toBe(0);
    expect(received).toBe("owned-descriptor");
  } finally { child.kill("SIGKILL"); vi.unstubAllEnvs(); }
});
