import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectMacShimHost, readCdHashes, type RunTool } from "@desktop/main/installed-apps/mac-host";

describe("macOS shim host detection", () => {
  let root: string;
  let hostApp: string;
  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    root = await mkdtemp(join(tmpdir(), "mac-host-"));
    hostApp = join(root, "Matrix OS.app");
    const helpers = join(hostApp, "Contents/Frameworks/Electron Framework.framework/Helpers");
    await mkdir(helpers, { recursive: true });
    await writeFile(join(helpers, "app_shim_loader"), "loader");
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  const tools = (overrides: { team?: string; codesignFails?: boolean } = {}): RunTool => vi.fn(async (file, args) => {
    if (file === "/usr/bin/plutil") {
      return { stdout: args[1] === "CFBundleIdentifier" ? "com.matrix-os.operator\n" : "icon\n", stderr: "" };
    }
    if (overrides.codesignFails) throw new Error("code object is not signed at all");
    return { stdout: "", stderr: `Executable=x\nTeamIdentifier=${overrides.team ?? "ABCDE12345"}\nCDHash=${"ab".repeat(20)}\n` };
  });

  it("reads a packaged app's bundle id, team and icon, and launches it with no arguments", async () => {
    const run = tools();
    const host = await detectMacShimHost({ execPath: join(hostApp, "Contents/MacOS/Matrix OS"), appPath: "/unused", isPackaged: true, run });
    expect(host).toEqual({
      appPath: hostApp,
      bundleId: "com.matrix-os.operator",
      teamId: "ABCDE12345",
      loaderPath: join(hostApp, "Contents/Frameworks/Electron Framework.framework/Helpers/app_shim_loader"),
      fallbackIcnsPath: join(hostApp, "Contents/Resources/icon.icns"),
      hostArguments: [],
    });
    for (const [file] of (run as ReturnType<typeof vi.fn>).mock.calls) expect(String(file)).toMatch(/^\/usr\/bin\//);
  });

  it("launches an unpacked dev app with its app directory, using the repo icon and no team when unsigned", async () => {
    const host = await detectMacShimHost({ execPath: join(hostApp, "Contents/MacOS/Electron"), appPath: "/repo/desktop",
      isPackaged: false, run: tools({ codesignFails: true }) });
    expect(host).toMatchObject({ teamId: null, hostArguments: ["/repo/desktop"], fallbackIcnsPath: "/repo/desktop/build/icon.icns" });
  });

  it("returns null outside an app bundle or without the shim loader", async () => {
    expect(await detectMacShimHost({ execPath: "/usr/local/bin/electron", appPath: "/x", isPackaged: false, run: tools() })).toBeNull();
    await rm(join(hostApp, "Contents/Frameworks"), { recursive: true });
    expect(await detectMacShimHost({ execPath: join(hostApp, "Contents/MacOS/Matrix OS"), appPath: "/x", isPackaged: true, run: tools() })).toBeNull();
  });

  it("reads cdhashes from codesign's stderr", async () => {
    expect(await readCdHashes(tools(), "/x/app-shim")).toEqual(["ab".repeat(20)]);
  });
});
