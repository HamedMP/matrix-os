import { describe, expect, it } from "vitest";
import {
  createSourceDaemonServiceCommand,
  createStandaloneDaemonServiceCommand,
  escapeXml,
  launchdPlist,
  systemdUnit,
} from "../../src/daemon/service.js";

describe("escapeXml", () => {
  it("escapes launchd XML metacharacters in interpolated paths", () => {
    expect(escapeXml(`bad<&>"'path`)).toBe(
      "bad&lt;&amp;&gt;&quot;&apos;path",
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
      "/home/user/.local/bin/matrix",
      "/home/user",
    );
    const unit = systemdUnit(command);
    const plist = launchdPlist(command, "/home/user/.matrixos/logs");

    expect(command.args).toEqual(["__daemon"]);
    expect(unit).toContain("WorkingDirectory=/home/user");
    expect(unit).toContain("ExecStart=/home/user/.local/bin/matrix __daemon");
    expect(unit).not.toContain("/daemon/launcher.mjs");
    expect(plist).toContain("<string>/home/user/.local/bin/matrix</string>");
    expect(plist).toContain("<string>__daemon</string>");
  });
});
