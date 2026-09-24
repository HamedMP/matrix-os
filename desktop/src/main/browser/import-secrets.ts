import { execFile } from "node:child_process";
import { copyFile, lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { decodeChromiumCookieValue, decryptChromiumBytes, decryptChromiumSecret, normalizeChromiumCookie, normalizeChromiumLogin, type BrowserCookie, type BrowserLogin } from "./chromium-secrets";
import type { BrowserPasswordVault } from "./password-vault";

const execFileAsync = promisify(execFile);
const PROFILE = /^(?:Default|Profile [1-9]\d{0,2})$/;
const HOST = /^(?=.{1,253}$)[a-zA-Z0-9]+(?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;
const MAX_DB_BYTES = 1024 * 1024 * 1024;
const MAX_ROWS = 50_000;
const MAX_PREVIEW_SITES = 5_000;
const SOURCE_BROWSERS = [
  { id: "arc", browser: "Arc", directory: "Arc/User Data", service: "Arc Safe Storage" },
  { id: "chrome", browser: "Chrome", directory: "Google/Chrome", service: "Chrome Safe Storage" },
  { id: "brave", browser: "Brave", directory: "BraveSoftware/Brave-Browser", service: "Brave Safe Storage" },
  { id: "edge", browser: "Microsoft Edge", directory: "Microsoft Edge", service: "Microsoft Edge Safe Storage" },
  { id: "vivaldi", browser: "Vivaldi", directory: "Vivaldi", service: "Vivaldi Safe Storage" },
  { id: "opera", browser: "Opera", directory: "com.operasoftware.Opera", service: "Opera Safe Storage" },
  { id: "chromium", browser: "Chromium", directory: "Chromium", service: "Chromium Safe Storage" },
] as const;

export interface ChromiumSecretSource { id: string; browser: string; profile: string }
export interface ChromiumSitePreview { host: string; passwords: number; cookies: number }

function source(home: string, sourceId: string, platform: NodeJS.Platform) {
  if (platform !== "darwin") throw new Error("local browser import unavailable");
  const [browserId, profile, extra] = sourceId.split(":");
  const browser = SOURCE_BROWSERS.find((item) => item.id === browserId);
  if (!browser || !profile || extra || !PROFILE.test(profile) || (browser.id === "opera" && profile !== "Default")) {
    throw new Error("invalid browser source");
  }
  const root = join(home, "Library", "Application Support", browser.directory);
  return { browser, profile, directory: browser.id === "opera" ? root : join(root, profile) };
}

async function confinedFile(home: string, path: string): Promise<boolean> {
  const root = resolve(home);
  const suffix = relative(root, resolve(path));
  if (!suffix || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) return false;
  let current = root;
  const segments = suffix.split(sep);
  try {
    for (let index = 0; index < segments.length; index++) {
      current = join(current, segments[index]!);
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || (index === segments.length - 1 ? !stat.isFile() || stat.size > MAX_DB_BYTES : !stat.isDirectory())) return false;
    }
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error("local browser import unavailable");
  }
}

async function databasePath(home: string, directory: string, kind: "logins" | "cookies"): Promise<string | null> {
  const names = kind === "logins" ? ["Login Data"] : ["Network/Cookies", "Cookies"];
  for (const name of names) {
    const path = join(directory, name);
    if (await confinedFile(home, path)) return path;
  }
  return null;
}

/** Read a source database with SQLite's read-only mode; snapshot only if a live browser holds its lock. */
async function queryRows(home: string, path: string, sql: string): Promise<Record<string, unknown>[]> {
  async function run(file: string): Promise<Record<string, unknown>[]> {
    const { stdout } = await execFileAsync("/usr/bin/sqlite3", ["-readonly", "-json", file, sql], {
      timeout: 10_000, maxBuffer: 32 * 1024 * 1024,
    });
    const parsed: unknown = JSON.parse(stdout || "[]");
    if (!Array.isArray(parsed) || parsed.length > MAX_ROWS) throw new Error("invalid browser database");
    return parsed.filter((row): row is Record<string, unknown> => row !== null && typeof row === "object" && !Array.isArray(row));
  }
  try {
    return await run(path);
  } catch {
    const temporary = await mkdtemp(join(tmpdir(), "matrix-browser-snapshot-"));
    try {
      const destination = join(temporary, basename(path));
      await copyFile(path, destination);
      for (const suffix of ["-wal", "-shm"]) {
        const sidecar = `${path}${suffix}`;
        if (await confinedFile(home, sidecar)) await copyFile(sidecar, `${destination}${suffix}`);
      }
      return await run(destination);
    } catch {
      throw new Error("local browser database unavailable");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

const LOGIN_META_SQL = "SELECT origin_url FROM logins WHERE blacklisted_by_user = 0 LIMIT 10000";
const COOKIE_META_SQL = "SELECT host_key FROM cookies LIMIT 50000";
const LOGIN_SQL = "SELECT origin_url, username_value, hex(password_value) AS secret_hex, blacklisted_by_user FROM logins WHERE blacklisted_by_user = 0 LIMIT 10000";

async function cookieRows(home: string, path: string): Promise<Record<string, unknown>[]> {
  const columns = await queryRows(home, path, "PRAGMA table_info(cookies)");
  if (columns.length > 2_000) throw new Error("invalid browser database");
  const tables = await queryRows(home, path, "SELECT name FROM sqlite_master WHERE type='table' AND name='meta' LIMIT 1");
  const partition = columns.some((row) => row.name === "top_frame_site_key") ? "top_frame_site_key" : "''";
  const version = tables.length ? "(SELECT value FROM meta WHERE key='version')" : "0";
  return queryRows(home, path, `SELECT host_key, ${partition} AS top_frame_site_key, name, value, hex(encrypted_value) AS secret_hex, path, expires_utc, is_secure, is_httponly, is_persistent, samesite, ${version} AS db_version FROM cookies LIMIT 50000`);
}

function hostFromUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2_048 || !URL.canParse(value)) return null;
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.hostname.toLowerCase() : null;
}

function cookieHost(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const host = value.replace(/^\./, "").toLowerCase();
  return HOST.test(host) && !host.includes("..") ? host : null;
}

export async function listChromiumSecretSources(home: string, platform: NodeJS.Platform = process.platform): Promise<ChromiumSecretSource[]> {
  if (platform !== "darwin") return [];
  const results: ChromiumSecretSource[] = [];
  for (const browser of SOURCE_BROWSERS) {
    const root = join(home, "Library", "Application Support", browser.directory);
    let profiles: string[];
    try { profiles = browser.id === "opera" ? ["Default"] : (await readdir(root)).filter((item) => PROFILE.test(item)).slice(0, 32); }
    catch { continue; }
    for (const profile of profiles) {
      const directory = browser.id === "opera" ? root : join(root, profile);
      if (await databasePath(home, directory, "logins") || await databasePath(home, directory, "cookies")) {
        results.push({ id: `${browser.id}:${profile}`, browser: browser.browser, profile });
      }
    }
  }
  return results;
}

export async function previewChromiumSites(
  home: string, sourceId: string, platform: NodeJS.Platform = process.platform,
): Promise<ChromiumSitePreview[]> {
  const selected = source(home, sourceId, platform);
  const [loginPath, cookiePath] = await Promise.all([
    databasePath(home, selected.directory, "logins"), databasePath(home, selected.directory, "cookies"),
  ]);
  if (!loginPath && !cookiePath) throw new Error("local browser import unavailable");
  const counts = new Map<string, ChromiumSitePreview>();
  function add(host: string, kind: "passwords" | "cookies") {
    const item = counts.get(host) ?? { host, passwords: 0, cookies: 0 };
    item[kind] += 1;
    if (counts.has(host)) counts.delete(host);
    else if (counts.size >= MAX_PREVIEW_SITES) counts.delete(counts.keys().next().value!);
    counts.set(host, item);
  }
  if (loginPath) for (const row of await queryRows(home, loginPath, LOGIN_META_SQL)) {
    const host = hostFromUrl(row.origin_url); if (host) add(host, "passwords");
  }
  if (cookiePath) for (const row of await queryRows(home, cookiePath, COOKIE_META_SQL)) {
    const host = cookieHost(row.host_key); if (host) add(host, "cookies");
  }
  return [...counts.values()].sort((a, b) => a.host.localeCompare(b.host));
}

export async function getMacKeychainPassword(service: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("/usr/bin/security", ["find-generic-password", "-s", service, "-w"], {
      timeout: 120_000, maxBuffer: 4096,
    });
    const password = stdout.replace(/\r?\n$/, "");
    if (!password || password.length > 4096) throw new Error("invalid keychain value");
    return password;
  } catch {
    throw new Error("Keychain access was unavailable or declined");
  }
}

export async function importChromiumSites(options: {
  home: string;
  sourceId: string;
  hosts: string[];
  platform?: NodeJS.Platform;
  getKeychainPassword?: (service: string) => Promise<string>;
  vault: BrowserPasswordVault;
  setCookie: (cookie: BrowserCookie) => Promise<void>;
}): Promise<{ passwords: number; cookies: number; skipped: number }> {
  if (!Array.isArray(options.hosts) || options.hosts.length === 0 || options.hosts.length > 5_000 ||
    options.hosts.some((host) => !HOST.test(host) || host !== host.toLowerCase() || host.includes(".."))) {
    throw new Error("invalid website selection");
  }
  const selected = source(options.home, options.sourceId, options.platform ?? process.platform);
  const [loginPath, cookiePath] = await Promise.all([
    databasePath(options.home, selected.directory, "logins"),
    databasePath(options.home, selected.directory, "cookies"),
  ]);
  if (!loginPath && !cookiePath) throw new Error("local browser import unavailable");
  const hosts = new Set(options.hosts);
  const logins: BrowserLogin[] = [];
  const cookies: BrowserCookie[] = [];
  let skipped = 0;
  let loginRows: Record<string, unknown>[] = [];
  let selectedCookieRows: Record<string, unknown>[] = [];
  let failedDatabases = 0;
  if (loginPath) {
    try { loginRows = (await queryRows(options.home, loginPath, LOGIN_SQL))
      .filter((row) => hosts.has(hostFromUrl(row.origin_url) ?? "")); }
    catch { failedDatabases++; skipped++; }
  }
  if (cookiePath) {
    try { selectedCookieRows = (await cookieRows(options.home, cookiePath))
      .filter((row) => hosts.has(cookieHost(row.host_key) ?? "")); }
    catch { failedDatabases++; skipped++; }
  }
  if (failedDatabases === Number(Boolean(loginPath)) + Number(Boolean(cookiePath))) {
    throw new Error("local browser database unavailable");
  }
  const needsKeychain = [...loginRows, ...selectedCookieRows]
    .some((row) => typeof row.secret_hex === "string" && row.secret_hex.length > 0);
  let password: string | null = null;
  if (needsKeychain) {
    try {
      password = await (options.getKeychainPassword ?? getMacKeychainPassword)(selected.browser.service);
    } catch {
      const hasPlaintextCookie = selectedCookieRows.some((row) => !row.secret_hex && typeof row.value === "string");
      if (!hasPlaintextCookie) throw new Error("Keychain access was unavailable or declined");
      console.warn("[browser-import] Keychain unavailable; continuing with selected plaintext cookies");
    }
  }
  for (const row of loginRows) {
    const hex = row.secret_hex;
    const value = password !== null && typeof hex === "string" && /^[0-9A-F]*$/.test(hex) && hex.length <= 128 * 1024
      ? decryptChromiumSecret(Buffer.from(hex, "hex"), password) : null;
    const login = value === null ? null : normalizeChromiumLogin(row, value);
    if (login) logins.push(login); else skipped++;
  }
  for (const row of selectedCookieRows) {
    const hex = row.secret_hex;
    const encrypted = typeof hex === "string" && hex.length > 0;
    const value = encrypted
      ? password !== null && /^[0-9A-F]+$/.test(hex) && hex.length <= 128 * 1024
        ? (() => {
            const raw = decryptChromiumBytes(Buffer.from(hex, "hex"), password);
            return raw ? decodeChromiumCookieValue(raw, String(row.host_key), Number(row.db_version)) : null;
          })()
        : null
      : typeof row.value === "string" ? row.value : null;
    const cookie = value === null ? null : normalizeChromiumCookie(row, value);
    if (cookie) cookies.push(cookie); else skipped++;
  }
  if (logins.length) await options.vault.upsertMany(logins);
  let importedCookies = 0;
  for (const cookie of cookies) {
    try { await options.setCookie(cookie); importedCookies++; }
    catch { skipped++; }
  }
  return { passwords: logins.length, cookies: importedCookies, skipped };
}
