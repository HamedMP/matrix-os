import { describe, expect, it } from "vitest";
import {
  createSourceDaemonServiceCommand,
  createStandaloneDaemonServiceCommand,
  escapeSystemdUnitValue,
  escapeSystemdExecArg,
  escapeXml,
  launchdPlist,
  linuxStartServiceCommands,
  systemdUnit,
} from "../../src/daemon/service.js";

describe("escapeXml", () => {
  it("escapes launchd XML metacharacters in interpolated paths", () => {
    expect(escapeXml(`bad<&>"'path`)).toBe(
      "bad&lt;&amp;&gt;&quot;&apos;path",
    );
  });
});

describe("escapeSystemdExecArg", () => {
  it("leaves simple systemd ExecStart arguments unquoted", () => {
    expect(escapeSystemdExecArg("/home/user/.local/bin/matrix")).toBe(
      "/home/user/.local/bin/matrix",
    );
  });

  it("quotes systemd ExecStart arguments that need escaping", () => {
    expect(escapeSystemdExecArg('/home/User Name/bin/matrix"$\\%')).toBe(
      '"/home/User Name/bin/matrix\\"$$\\\\%%"',
    );
  });
});

describe("escapeSystemdUnitValue", () => {
  it("escapes systemd specifiers and whitespace in WorkingDirectory values", () => {
    expect(escapeSystemdUnitValue("/home/User Name/%h/project")).toBe(
      "/home/User\\x20Name/%%h/project",
    );
  });

  it("uses systemd Unicode escapes for non-ASCII WorkingDirectory values", () => {
    expect(escapeSystemdUnitValue("/home/Zoë/🚀/%h")).toBe(
      "/home/Zo\\u00eb/\\U0001f680/%%h",
    );
  });
});

describe("daemon service command rendering", () => {
  it("keeps source installs pointed at the daemon launcher file", () => {
    const command = createSourceDaemonServiceCommand(
      "/repo/packages/sync-client/src/daemon/launcher.mjs",
    );
    const unit = systemdUnit(command);

    expect(command.executable).toBe(process.execPath);
    expect(command.args).toEqual([
      "/repo/packages/sync-client/src/daemon/launcher.mjs",
    ]);
    expect(unit).toContain(
      `ExecStart=${process.execPath} /repo/packages/sync-client/src/daemon/launcher.mjs`,
    );
  });

  it("points standalone binary installs at the bundled daemon entrypoint", () => {
    const command = createStandaloneDaemonServiceCommand(
      "/home/User Name/.local/bin/matrix",
      "/home/user",
    );
    const unit = systemdUnit(command);
    const plist = launchdPlist(command, "/home/user/.matrixos/logs");

    expect(command.args).toEqual(["__daemon"]);
    expect(unit).toContain("WorkingDirectory=/home/user");
    expect(unit).toContain(
      'ExecStart="/home/User Name/.local/bin/matrix" __daemon',
    );
    expect(unit).not.toContain("/daemon/launcher.mjs");
    expect(plist).toContain(
      "<string>/home/User Name/.local/bin/matrix</string>",
    );
    expect(plist).toContain("<string>__daemon</string>");
  });

  it("escapes standalone working directories before writing systemd units", () => {
    const command = createStandaloneDaemonServiceCommand(
      "/home/user/.local/bin/matrix",
      "/home/User Name/%h",
    );

    expect(systemdUnit(command)).toContain("WorkingDirectory=/home/User\\x20Name/%%h");
  });
});

describe("linuxStartServiceCommands", () => {
  it("restarts an already-active service so rewritten units take effect", () => {
    expect(linuxStartServiceCommands()).toEqual([
      ["--user", "daemon-reload"],
      ["--user", "enable", "matrixos-sync.service"],
      ["--user", "restart", "matrixos-sync.service"],
    ]);
  });
});
