import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveLauncherCommand } from "../../desktop/src/main/installed-apps/launcher-command";

describe("the command a launcher runs", () => {
  let root: string;
  let appImage: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "matrix-launcher-command-"));
    appImage = join(root, "Matrix-OS.AppImage");
    await writeFile(appImage, "elf");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const base = { execPath: "/tmp/.mount_MatrixXYZ/matrix-os", appPath: "/tmp/.mount_MatrixXYZ/resources/app.asar" };

  it("runs the AppImage itself on packaged Linux, never its temporary mount", async () => {
    await expect(resolveLauncherCommand({ ...base, platform: "linux", isPackaged: true, appImage }))
      .resolves.toEqual({ exePath: appImage, baseArgs: [] });
  });

  it("is unavailable on packaged Linux without a usable APPIMAGE", async () => {
    await mkdir(join(root, "dir.AppImage"));
    await symlink(appImage, join(root, "link.AppImage"));
    for (const candidate of [undefined, "", "Matrix-OS.AppImage", join(root, "missing.AppImage"), join(root, "dir.AppImage")]) {
      await expect(resolveLauncherCommand({ ...base, platform: "linux", isPackaged: true, appImage: candidate })).resolves.toBeNull();
    }
    // A symlink to the AppImage still names a regular file.
    await expect(resolveLauncherCommand({ ...base, platform: "linux", isPackaged: true, appImage: join(root, "link.AppImage") }))
      .resolves.toEqual({ exePath: join(root, "link.AppImage"), baseArgs: [] });
  });

  it("uses the executable plus the app path for unpackaged runs, ignoring APPIMAGE", async () => {
    await expect(resolveLauncherCommand({ execPath: "/opt/electron/electron", appPath: "/src/desktop", platform: "linux", isPackaged: false, appImage }))
      .resolves.toEqual({ exePath: "/opt/electron/electron", baseArgs: ["/src/desktop"] });
  });

  it("uses the installed executable on packaged Windows", async () => {
    await expect(resolveLauncherCommand({ execPath: "C:\\Matrix\\Matrix OS.exe", appPath: "x", platform: "win32", isPackaged: true, appImage: undefined }))
      .resolves.toEqual({ exePath: "C:\\Matrix\\Matrix OS.exe", baseArgs: [] });
  });
});
