import { describe, expect, it } from "vitest";
import {
  appShimLoaderPath,
  appShimServerName,
  bundleDisplayName,
  bundleFileName,
  hostAppBundlePath,
  looksLikeProtectedName,
  parseCdHashes,
  parseTeamId,
  sanitizeBundleName,
  shimBundleFiles,
  shimCodeRequirement,
  shimInfoPlist,
} from "@desktop/main/installed-apps/mac-bundle";

const ID = "6f1c2a4e-2b7d-4c1a-9f3e-1a2b3c4d5e6f";
const HOST = "/Applications/Matrix OS.app";
const CDHASH = "70319dee84e8125748db84fee5a36fceda50e82b";

const plistInput = {
  installId: ID,
  displayName: "Notes",
  hostPath: HOST,
  hostBundleId: "com.matrix-os.operator",
  serverName: "matrix-stable",
  hostArguments: [] as string[],
};

describe("bundle names", () => {
  it.each([
    ["Notes", "Notes"],
    ["  Notes   Pro  ", "Notes Pro"],
    ["../../etc/passwd", "etc passwd"],
    ["a/b\\c:d", "a b c d"],
    ["...hidden", "hidden"],
    ["Notes.app", "Notes"],
    ["Notes.APP.app", "Notes"],
    ["Line\nbreak\u0000", "Line break"],
    ["‮ppa.sloot", "ppa.sloot"],
    ["zero​width", "zerowidth"],
    ["", "Untitled App"],
    ["/./", "Untitled App"],
  ])("sanitizes %j to %j", (raw, expected) => {
    expect(sanitizeBundleName(raw)).toBe(expected);
  });

  it("caps a name at 64 characters without splitting a character", () => {
    expect(sanitizeBundleName("é".repeat(80))).toBe("é".repeat(64));
  });

  it("caps a name at 180 bytes so a numbered bundle file name stays under the 255-byte limit", () => {
    const name = sanitizeBundleName("😀".repeat(80));
    expect(name).toBe("😀".repeat(45));
    expect(Buffer.byteLength(bundleFileName(`${name} (Matrix App)`, 99))).toBeLessThan(255);
  });

  it.each([
    "Matrix", "Matrix OS", "MATRIX helper", "Mаtrix" /* Cyrillic a */, "Matr1x", "M a t r i x", "Rnatrix",
    "Apple", "App1e Store", "macOS Update", "mac0s", "iCloud Drive", "Finder", "Fіnder" /* Cyrillic i */,
    "Mätrix", "ｍａｔｒｉｘ", /* full width */
  ])("treats %j as a protected name", (name) => {
    expect(looksLikeProtectedName(name)).toBe(true);
    expect(bundleDisplayName(name)).toMatch(/ \(Matrix App\)$/);
  });

  it.each(["Notes", "Weather", "Tern Terminal", "Snake"])("leaves %j alone", (name) => {
    expect(looksLikeProtectedName(name)).toBe(false);
    expect(bundleDisplayName(name)).toBe(name);
  });

  it("numbers bundle files after the first", () => {
    expect(bundleFileName("Notes", 1)).toBe("Notes.app");
    expect(bundleFileName("Notes", 2)).toBe("Notes 2.app");
    expect(() => bundleFileName("Notes", 0)).toThrow();
  });
});

describe("app shim server name", () => {
  it.each([
    [{ channel: "stable" as const }, "matrix-stable"],
    [{ channel: "beta" as const }, "matrix-stable"],
    [{ channel: "canary" as const }, "matrix-canary"],
    [{ channel: "dev" as const }, "matrix-dev"],
    [{ channel: "stable" as const, previewHandle: "cp-12-abcdef12-3-a" }, "matrix-preview-cp-12-abcdef12-3-a"],
  ])("names the server for %j", (input, expected) => {
    expect(appShimServerName(input)).toBe(expected);
  });

  it("refuses a preview handle with characters the shim server cannot use", () => {
    expect(() => appShimServerName({ channel: "stable", previewHandle: "cp/12" })).toThrow();
  });
});

describe("Info.plist", () => {
  it("names the bundle, its shim executable and the four Electron app shim keys", () => {
    const plist = shimInfoPlist({ ...plistInput, hostArguments: ["/repo/desktop"] });
    expect(plist).toContain("<key>CFBundleIdentifier</key>\n\t<string>com.matrix-os.app.6f1c2a4e-2b7d-4c1a-9f3e-1a2b3c4d5e6f</string>");
    expect(plist).toContain("<key>CFBundleExecutable</key>\n\t<string>app-shim</string>");
    expect(plist).toContain("<key>CFBundleIconFile</key>\n\t<string>app</string>");
    expect(plist).toContain("<key>CFBundleName</key>\n\t<string>Notes</string>");
    expect(plist).toContain("<key>CFBundleDisplayName</key>\n\t<string>Notes</string>");
    expect(plist).toContain("<key>ElectronAppShimHostPath</key>\n\t<string>/Applications/Matrix OS.app</string>");
    expect(plist).toContain("<key>ElectronAppShimHostBundleIdentifier</key>\n\t<string>com.matrix-os.operator</string>");
    expect(plist).toContain("<key>ElectronAppShimServerName</key>\n\t<string>matrix-stable</string>");
    expect(plist).toContain("<key>ElectronAppShimHostArguments</key>\n\t<array>\n\t\t<string>/repo/desktop</string>\n\t</array>");
    expect(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(plist.trimEnd().endsWith("</plist>")).toBe(true);
  });

  it("escapes owner-controlled text", () => {
    const plist = shimInfoPlist({ ...plistInput, displayName: `A & <B> "C" 'D'`, hostPath: "/Apps/M&M.app" });
    expect(plist).toContain("<string>A &amp; &lt;B&gt; &quot;C&quot; &apos;D&apos;</string>");
    expect(plist).toContain("<string>/Apps/M&amp;M.app</string>");
    expect(plist).not.toContain("<B>");
  });

  it("refuses an install id that is not a UUID", () => {
    expect(() => shimInfoPlist({ ...plistInput, installId: "../notes" })).toThrow();
  });

  it("lists every file of the bundle, copying the loader without re-signing it", () => {
    const icon = new Uint8Array([1, 2, 3]);
    const files = shimBundleFiles({ ...plistInput, loaderPath: "/loader", icon });
    expect(files.map((file) => file.path)).toEqual([
      "Contents/Info.plist", "Contents/PkgInfo", "Contents/MacOS/app-shim", "Contents/Resources/app.icns",
    ]);
    expect(files[1]).toMatchObject({ contents: "APPL????" });
    expect(files[2]).toEqual({ path: "Contents/MacOS/app-shim", copyFrom: "/loader", mode: 0o755 });
    expect(files[3]).toEqual({ path: "Contents/Resources/app.icns", contents: icon, mode: 0o644 });
  });
});

describe("host app paths", () => {
  it("finds the running app bundle and its shim loader", () => {
    expect(hostAppBundlePath("/Applications/Matrix OS.app/Contents/MacOS/Matrix OS")).toBe("/Applications/Matrix OS.app");
    expect(appShimLoaderPath("/Applications/Matrix OS.app"))
      .toBe("/Applications/Matrix OS.app/Contents/Frameworks/Electron Framework.framework/Helpers/app_shim_loader");
  });

  it.each(["/usr/bin/node", "/Applications/Matrix OS.app/Contents/Resources/x", "relative/X.app/Contents/MacOS/X"])(
    "returns null for %s", (execPath) => {
      expect(hostAppBundlePath(execPath)).toBeNull();
    });
});

describe("code signatures", () => {
  const output = [
    "Executable=/x/app-shim",
    "CandidateCDHash sha256=1111111111111111111111111111111111111111",
    `CDHash=${CDHASH.toUpperCase()}`,
    "TeamIdentifier=ABCDE12345",
  ].join("\n");

  it("parses the code-directory hash and team", () => {
    expect(parseCdHashes(output)).toEqual([CDHASH]);
    expect(parseTeamId(output)).toBe("ABCDE12345");
  });

  it("treats an unsigned or ad-hoc signature as having no team", () => {
    expect(parseTeamId("TeamIdentifier=not set")).toBeNull();
    expect(parseCdHashes("code object is not signed at all")).toEqual([]);
    expect(parseCdHashes("CDHash=zz")).toEqual([]);
  });

  it("requires the recorded cdhash, plus the team anchor when the host is team-signed", () => {
    expect(shimCodeRequirement(CDHASH, null)).toBe(`cdhash H"${CDHASH}"`);
    expect(shimCodeRequirement(CDHASH, "ABCDE12345"))
      .toBe(`anchor apple generic and certificate leaf[subject.OU] = "ABCDE12345" and cdhash H"${CDHASH}"`);
  });

  it("refuses values that would change the requirement", () => {
    expect(() => shimCodeRequirement(`${CDHASH}" or true`, null)).toThrow();
    expect(() => shimCodeRequirement(CDHASH, `X" or anchor apple`)).toThrow();
  });
});
