// The macOS app-shim bundle of an installed Matrix app (spec 2711, layer 3):
// its name, Info.plist, file list and the code-signature checks. Pure, so it
// is unit-tested on every platform; mac-installer.ts writes what this returns.
import { posix } from "node:path";
import type { DesktopReleaseChannel } from "../../shared/channel-identity";
import { InstallIdSchema } from "./record";

export const MATRIX_APPS_FOLDER = "Matrix Apps";
export const SHIM_EXECUTABLE = "app-shim";
export const SHIM_ICON = "app.icns";
export const BUNDLE_TEMP_PREFIX = ".matrix-app-tmp-";
export const MAX_BUNDLE_NAME_CHARS = 64;
export const PROTECTED_NAME_SUFFIX = " (Matrix App)";

const FALLBACK_NAME = "Untitled App";
const MAX_BUNDLE_NAME_BYTES = 180;
const SERVER_NAME = /^[A-Za-z0-9._-]{1,128}$/;
const CDHASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const TEAM_ID = /^[A-Z0-9]{10}$/;

/** Folder-safe display name: no separators, controls, leading dots or `.app`; at most 64 characters. */
export function sanitizeBundleName(raw: string): string {
  let name = raw.normalize("NFC")
    .replace(/[\p{Cf}]/gu, "")
    .replace(/[\p{Cc}/\\:]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  for (let previous = ""; previous !== name;) {
    previous = name;
    name = name.replace(/^[.\s]+/u, "").replace(/(?:\.app)+$/iu, "").replace(/[.\s]+$/u, "");
  }
  let chars = Array.from(name).slice(0, MAX_BUNDLE_NAME_CHARS);
  while (chars.length > 0 && Buffer.byteLength(chars.join("")) > MAX_BUNDLE_NAME_BYTES) chars = chars.slice(0, -1);
  name = chars.join("").trim();
  return name || FALLBACK_NAME;
}

// Look-alike letters folded to the Latin letter they imitate. `i`, `l`, `1`
// and `|` all fold to `l`, and `rn` to `m`, so "Matr1x" and "Rnatrix" match.
const CONFUSABLES: Record<string, string> = {
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "l", "ј": "j", "ѕ": "s",
  "ԁ": "d", "ӏ": "l", "м": "m", "т": "t", "к": "k", "н": "h", "в": "b",
  "α": "a", "ο": "o", "ρ": "p", "ι": "l", "ν": "v", "τ": "t", "κ": "k", "χ": "x", "μ": "u",
  "ı": "l", "ł": "l", "ø": "o", "ß": "ss",
  "i": "l", "1": "l", "!": "l", "|": "l", "0": "o", "5": "s", "$": "s", "@": "a",
};

function skeleton(value: string): string {
  const folded = Array.from(value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase())
    .map((character) => CONFUSABLES[character] ?? character)
    .join("")
    .replace(/[^a-z]/g, "");
  return folded.replace(/rn/g, "m");
}

const PROTECTED_SKELETONS = ["matrix", "apple", "macos", "icloud", "finder"].map(skeleton);

/** True when a name could pass for Matrix or a system app (Apple, macOS, iCloud, Finder). */
export function looksLikeProtectedName(name: string): boolean {
  const folded = skeleton(name);
  return PROTECTED_SKELETONS.some((target) => folded.includes(target));
}

/** The name shown in the Dock and Finder: sanitized, with " (Matrix App)" when it could spoof. */
export function bundleDisplayName(raw: string): string {
  const name = sanitizeBundleName(raw);
  return looksLikeProtectedName(name) ? `${name}${PROTECTED_NAME_SUFFIX}` : name;
}

/** `Name.app`, then `Name 2.app`, `Name 3.app`… for later attempts. */
export function bundleFileName(displayName: string, attempt: number): string {
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError("invalid bundle attempt");
  return attempt === 1 ? `${displayName}.app` : `${displayName} ${attempt}.app`;
}

/**
 * Each channel serves only its own shims. Beta shares stable's identity and
 * profile, so it shares stable's server; a preview pair gets its own.
 */
export function appShimServerName(options: { channel: DesktopReleaseChannel; previewHandle?: string }): string {
  if (options.previewHandle !== undefined) {
    const name = `matrix-preview-${options.previewHandle}`;
    if (!SERVER_NAME.test(name)) throw new RangeError("invalid preview handle");
    return name;
  }
  return `matrix-${options.channel === "beta" ? "stable" : options.channel}`;
}

export function shimBundleIdentifier(installId: string): string {
  return `com.matrix-os.app.${InstallIdSchema.parse(installId)}`;
}

function escapeXml(value: string): string {
  // Characters XML 1.0 cannot carry are dropped; the rest are escaped.
  return value.replace(/[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, "")
    .replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
    })[character]!);
}

export interface ShimInfoPlistInput {
  installId: string;
  displayName: string;
  /** The running Matrix `.app`, which the shim launches when Matrix is not running. */
  hostPath: string;
  hostBundleId: string;
  serverName: string;
  hostArguments: readonly string[];
}

export function shimInfoPlist(input: ShimInfoPlistInput): string {
  if (!SERVER_NAME.test(input.serverName)) throw new RangeError("invalid app shim server name");
  const string = (key: string, value: string) => `\t<key>${key}</key>\n\t<string>${escapeXml(value)}</string>`;
  const flag = (key: string) => `\t<key>${key}</key>\n\t<true/>`;
  const args = input.hostArguments.map((arg) => `\t\t<string>${escapeXml(arg)}</string>`).join("\n");
  const entries = [
    flag("CFBundleAllowMixedLocalizations"),
    string("CFBundleDevelopmentRegion", "en"),
    string("CFBundleDisplayName", input.displayName),
    string("CFBundleExecutable", SHIM_EXECUTABLE),
    string("CFBundleIconFile", "app"),
    string("CFBundleIdentifier", shimBundleIdentifier(input.installId)),
    string("CFBundleInfoDictionaryVersion", "6.0"),
    string("CFBundleName", input.displayName),
    string("CFBundlePackageType", "APPL"),
    string("CFBundleShortVersionString", "1.0"),
    string("CFBundleSignature", "????"),
    string("CFBundleVersion", "1"),
    `\t<key>ElectronAppShimHostArguments</key>\n\t<array>${args ? `\n${args}\n\t` : ""}</array>`,
    string("ElectronAppShimHostBundleIdentifier", input.hostBundleId),
    string("ElectronAppShimHostPath", input.hostPath),
    string("ElectronAppShimServerName", input.serverName),
    string("LSMinimumSystemVersion", "13.0"),
    flag("NSHighResolutionCapable"),
    string("NSPrincipalClass", "NSApplication"),
  ];
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    + `<plist version="1.0">\n<dict>\n${entries.join("\n")}\n</dict>\n</plist>\n`;
}

export type ShimBundleFile =
  | { path: string; contents: string | Uint8Array; mode: number }
  | { path: string; copyFrom: string; mode: number };

/**
 * Every file of a shim bundle, relative to `<Name>.app/`. The executable is a
 * byte copy of Electron's `app_shim_loader`: it is never re-signed, because
 * its own signature has no Info.plist binding.
 */
export function shimBundleFiles(input: ShimInfoPlistInput & { loaderPath: string; icon: Uint8Array }): ShimBundleFile[] {
  return [
    { path: "Contents/Info.plist", contents: shimInfoPlist(input), mode: 0o644 },
    { path: "Contents/PkgInfo", contents: "APPL????", mode: 0o644 },
    { path: `Contents/MacOS/${SHIM_EXECUTABLE}`, copyFrom: input.loaderPath, mode: 0o755 },
    { path: `Contents/Resources/${SHIM_ICON}`, contents: input.icon, mode: 0o644 },
  ];
}

/** `/…/Name.app` for an executable at `/…/Name.app/Contents/MacOS/<exe>`; null otherwise. */
export function hostAppBundlePath(execPath: string): string | null {
  if (!posix.isAbsolute(execPath)) return null;
  const macos = posix.dirname(execPath);
  const contents = posix.dirname(macos);
  const bundle = posix.dirname(contents);
  if (posix.basename(macos) !== "MacOS" || posix.basename(contents) !== "Contents" || !bundle.endsWith(".app")) return null;
  return bundle;
}

export function appShimLoaderPath(hostApp: string): string {
  return posix.join(hostApp, "Contents/Frameworks/Electron Framework.framework/Helpers/app_shim_loader");
}

/** `CDHash=` values from `codesign -dvvv` output, lower-cased. */
export function parseCdHashes(output: string): string[] {
  const hashes = [...output.matchAll(/^CDHash=(\S+)$/gm)].map((match) => match[1]!.toLowerCase());
  return [...new Set(hashes.filter((hash) => CDHASH.test(hash)))];
}

/** The signing team from `codesign -dv` output; null for ad-hoc or unsigned code. */
export function parseTeamId(output: string): string | null {
  const team = /^TeamIdentifier=(\S+)$/m.exec(output)?.[1];
  return team && TEAM_ID.test(team) ? team : null;
}

/** The code requirement a connecting shim must satisfy (spec 2711 "Trust check"). */
export function shimCodeRequirement(cdHash: string, teamId: string | null): string {
  if (!CDHASH.test(cdHash)) throw new RangeError("invalid cdhash");
  if (teamId !== null && !TEAM_ID.test(teamId)) throw new RangeError("invalid team id");
  const pin = `cdhash H"${cdHash}"`;
  return teamId ? `anchor apple generic and certificate leaf[subject.OU] = "${teamId}" and ${pin}` : pin;
}
