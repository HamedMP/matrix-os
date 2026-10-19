import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import config from "../../desktop/electron-builder.windows-preview.mjs";
import { resolveWindowsSigningConfig } from "../../scripts/release/windows-signing-config.mjs";

const desktopRequire = createRequire(resolve("desktop/package.json"));
const builderRequire = createRequire(desktopRequire.resolve("electron-builder"));
builderRequire("app-builder-lib"); // Initialize the package before its platform subclass.
const { WinPackager } = builderRequire("app-builder-lib/out/winPackager.js");

describe("unsigned Windows previews preserve protected release signing", () => {
  it("skips signing using the installed builder while preserving resource edits and updater verification", async () => {
    expect(config.extends).toBe("./electron-builder.yml");
    expect(config.forceCodeSigning).toBe(false);
    expect(config.win).toEqual({ signExecutable: false });
    const base = YAML.parse(readFileSync("desktop/electron-builder.yml", "utf8"));
    expect(base.win.verifyUpdateCodeSignature).toBe(true);
    const doSign = vi.fn(() => { throw new Error("Signing must never run for a preview"); });
    await WinPackager.prototype.signIf.call({
      platformSpecificBuildOptions: config.win, shouldSignFile: () => true, _sign: doSign,
    }, "preview-installer.exe");
    expect(doSign).not.toHaveBeenCalled();
    expect(() => resolveWindowsSigningConfig({ MATRIX_DESKTOP_WINDOWS_SIGNING_MODE: "unsigned" })).toThrow();
  });

  it("retains the native installer, protocol, loopback-updater and uninstall qualification", () => {
    const smoke = readFileSync("scripts/ci/preview-windows-smoke.ps1", "utf8");
    for (const check of [
      "::NotSigned", "Get-AuthenticodeSignature", "Get-ChildItem desktop/dist", "asar list",
      'Start-Process -FilePath $installerPath -ArgumentList "/S" -Wait',
      '$_.DisplayVersion -eq $env:PACKAGE_VERSION',
      'foreach ($scheme in @("matrixos", "matrix-os"))',
      '"--platform", "windows"', "[updates] update check completed: up to date",
      "ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING",
      'Start-Process -FilePath $uninstallerPath -ArgumentList "/S" -Wait',
      "Silent NSIS uninstall left the installed app behind",
      "windows-preview-source.json", "sourceSha = $env:DESKTOP_SOURCE_SHA", "signed = $false",
    ]) expect(smoke).toContain(check);
  });
});
