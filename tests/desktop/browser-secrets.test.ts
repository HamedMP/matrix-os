import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decryptChromiumSecret,
  decodeChromiumCookieValue,
  normalizeChromiumCookie,
  normalizeChromiumLogin,
} from "@desktop/main/browser/chromium-secrets";
import { createBrowserPasswordVault } from "@desktop/main/browser/password-vault";
import { importOnePasswordLogins, listOnePasswordLogins, parseOnePasswordLogin } from "@desktop/main/browser/one-password";
import { importChromiumSites, listChromiumSecretSources, previewChromiumSites } from "@desktop/main/browser/import-secrets";
import { exportBrowserPasswords } from "@desktop/main/browser/password-export";
import { INVOKE_CHANNELS } from "@desktop/shared/ipc-contract";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Chromium local secret import", () => {
  const safeStoragePassword = "synthetic-keychain-value";
  const key = pbkdf2Sync(safeStoragePassword, "saltysalt", 1003, 16, "sha1");
  const iv = Buffer.alloc(16, 0x20);
  function encrypted(value: string): Buffer {
    const cipher = createCipheriv("aes-128-cbc", key, iv);
    return Buffer.concat([Buffer.from("v10"), cipher.update(value), cipher.final()]);
  }

  it("decrypts supported v10 values in memory and rejects unknown formats", () => {
    expect(decryptChromiumSecret(encrypted("synthetic password"), safeStoragePassword)).toBe("synthetic password");
    expect(decryptChromiumSecret(Buffer.from("v20garbage"), safeStoragePassword)).toBeNull();
    expect(decryptChromiumSecret(Buffer.from("v10bad"), safeStoragePassword)).toBeNull();
  });

  it("checks the domain digest in current Chromium cookie databases", () => {
    const digest = createHash("sha256").update(".example.com").digest();
    const raw = Buffer.concat([digest, Buffer.from("synthetic-cookie")]);
    expect(decodeChromiumCookieValue(raw, ".example.com", 24)).toBe("synthetic-cookie");
    expect(decodeChromiumCookieValue(raw, ".other.example", 24)).toBeNull();
    expect(decodeChromiumCookieValue(Buffer.from("legacy"), ".example.com", 23)).toBe("legacy");
  });

  it("normalizes only web logins with a username and decrypted password", () => {
    expect(normalizeChromiumLogin({
      origin_url: "https://example.com/login", username_value: "alice", blacklisted_by_user: 0,
    }, "secret")).toEqual({ origin: "https://example.com", username: "alice", password: "secret" });
    expect(normalizeChromiumLogin({ origin_url: "javascript:bad", username_value: "alice" }, "secret")).toBeNull();
    expect(normalizeChromiumLogin({ origin_url: "https://example.com", username_value: "alice", blacklisted_by_user: 1 }, "secret")).toBeNull();
  });

  it("converts host cookies and skips partitioned or expired cookies", () => {
    const now = Date.parse("2026-09-24T00:00:00Z") / 1000;
    const expiresUtc = (now + 3600 + 11_644_473_600) * 1_000_000;
    expect(normalizeChromiumCookie({
      host_key: ".example.com", top_frame_site_key: "", name: "session", path: "/",
      is_secure: 1, is_httponly: 1, samesite: 2, expires_utc: expiresUtc,
      is_persistent: 1,
    }, "synthetic-cookie", now)).toEqual({
      url: "https://example.com/", domain: ".example.com", name: "session",
      value: "synthetic-cookie", path: "/", secure: true, httpOnly: true,
      sameSite: "strict", expirationDate: now + 3600,
    });
    expect(normalizeChromiumCookie({ host_key: "example.com", top_frame_site_key: "https://other.example", name: "x", path: "/" }, "value", now)).toBeNull();
    expect(normalizeChromiumCookie({ host_key: "example.com", name: "x", path: "/", is_persistent: 1, expires_utc: 1 }, "value", now)).toBeNull();
  });
});

describe("OS-encrypted Matrix Browser password vault", () => {
  it("stores no plaintext, deduplicates a site login, and returns only metadata for listing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "matrix-password-vault-"));
    dirs.push(dir);
    const key = randomBytes(32);
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => {
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", key, iv);
        const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), body]);
      },
      decryptString: (value: Buffer) => {
        const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
        decipher.setAuthTag(value.subarray(12, 28));
        return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8");
      },
    };
    const vault = createBrowserPasswordVault({ dir, safeStorage });
    await vault.upsertMany([{ origin: "https://example.com", username: "alice", password: "secret-one" }]);
    await vault.upsertMany([{ origin: "https://example.com", username: "alice", password: "secret-two" }]);
    expect(await vault.list()).toEqual([{ origin: "https://example.com", username: "alice" }]);
    expect(await vault.find("https://example.com", "alice")).toEqual({ origin: "https://example.com", username: "alice", password: "secret-two" });
    expect(await vault.all()).toEqual([{ origin: "https://example.com", username: "alice", password: "secret-two" }]);
    expect(await vault.remove("https://example.com", "alice")).toBe(true);
    expect(await vault.list()).toEqual([]);
    const file = await readFile(join(dir, "browser-passwords.bin"));
    expect(file.toString("utf8")).not.toContain("secret-two");
  });

  it("refuses plaintext storage when OS encryption is unavailable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "matrix-password-vault-"));
    dirs.push(dir);
    const vault = createBrowserPasswordVault({ dir, safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => "",
    } });
    await expect(vault.upsertMany([{ origin: "https://example.com", username: "a", password: "b" }]))
      .rejects.toThrow("OS encryption unavailable");
  });

  it("rejects a symlinked vault file before reading it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "matrix-password-link-"));
    dirs.push(dir);
    const outside = join(dir, "outside.bin");
    await writeFile(outside, "synthetic-secret");
    await symlink(outside, join(dir, "browser-passwords.bin"));
    const decryptString = vi.fn(() => "[]");
    const vault = createBrowserPasswordVault({ dir, safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: () => Buffer.alloc(0),
      decryptString,
    } });
    await expect(vault.list()).rejects.toThrow("browser password vault unavailable");
    expect(decryptString).not.toHaveBeenCalled();
  });

  it("exports only to an explicitly chosen new file with owner-only permissions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "matrix-password-export-"));
    dirs.push(dir);
    const target = join(dir, "passwords.json");
    const vault = { all: async () => [{ origin: "https://example.com", username: "alice", password: "synthetic-export-secret" }] };
    expect(await exportBrowserPasswords(vault, async () => target)).toBe(true);
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ version: 1, logins: await vault.all() });
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    await writeFile(target, "preserve");
    await expect(exportBrowserPasswords(vault, async () => target)).rejects.toThrow("password export unavailable");
    expect(await readFile(target, "utf8")).toBe("preserve");
  });
});

describe("1Password direct import", () => {
  it("accepts a Login with a supported website, username, and concealed password", () => {
    expect(parseOnePasswordLogin({ category: "LOGIN", urls: [{ href: "https://example.com/login" }], fields: [
      { id: "username", value: "alice" }, { id: "password", value: "secret", type: "CONCEALED" },
    ] })).toEqual({ origin: "https://example.com", username: "alice", password: "secret" });
    expect(parseOnePasswordLogin({ category: "LOGIN", urls: [{ href: "file:///private/secret" }], fields: [] })).toBeNull();
  });

  it("lists metadata and fetches selected item secrets only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "matrix-op-vault-"));
    dirs.push(dir);
    const vault = createBrowserPasswordVault({ dir, safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value).map((byte) => byte ^ 0xa5),
      decryptString: (value: Buffer) => Buffer.from(value).map((byte) => byte ^ 0xa5).toString(),
    } });
    const calls: string[][] = [];
    const list = [{ id: "abcdefghijkl", title: "Example", category: "LOGIN", urls: [{ href: "https://example.com/login" }] },
      { id: "mnopqrstuvwx", title: "Other", category: "LOGIN", urls: [{ href: "https://other.example" }] }];
    const run = async (args: string[]) => {
      calls.push(args);
      if (args[1] === "list") return list;
      return { ...list[0], fields: [{ id: "username", value: "alice" }, { id: "password", value: "synthetic-op-secret" }] };
    };
    expect(await listOnePasswordLogins(run)).toEqual([
      { id: "abcdefghijkl", title: "Example", origin: "https://example.com" },
      { id: "mnopqrstuvwx", title: "Other", origin: "https://other.example" },
    ]);
    expect(await importOnePasswordLogins(["abcdefghijkl"], vault, run)).toEqual({ imported: 1, skipped: 0 });
    expect(calls.filter((args) => args[1] === "get")).toEqual([["item", "get", "abcdefghijkl", "--format", "json", "--reveal"]]);
    expect(await vault.find("https://example.com", "alice")).toMatchObject({ password: "synthetic-op-secret" });
  });
});

describe("selected local browser profile transfer", () => {
  it("discovers Arc, previews only site metadata, then transfers selected secrets", async () => {
    const home = await mkdtemp(join(tmpdir(), "matrix-source-home-"));
    const vaultDir = await mkdtemp(join(tmpdir(), "matrix-target-vault-"));
    dirs.push(home, vaultDir);
    const profile = join(home, "Library/Application Support/Arc/User Data/Default");
    await mkdir(profile, { recursive: true });
    const dbLogin = join(profile, "Login Data");
    const dbCookies = join(profile, "Cookies");
    const secret = "synthetic-keychain-value";
    const key = pbkdf2Sync(secret, "saltysalt", 1003, 16, "sha1");
    const encrypt = (value: string, cookieHost?: string) => {
      const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
      const raw = cookieHost ? Buffer.concat([createHash("sha256").update(cookieHost).digest(), Buffer.from(value)]) : Buffer.from(value);
      return Buffer.concat([Buffer.from("v10"), cipher.update(raw), cipher.final()]).toString("hex");
    };
    execFileSync("/usr/bin/sqlite3", [dbLogin, `CREATE TABLE logins (origin_url TEXT, username_value TEXT, password_value BLOB, blacklisted_by_user INTEGER);
      INSERT INTO logins VALUES ('https://example.com/login', 'alice', X'${encrypt("selected-secret")}', 0);
      INSERT INTO logins VALUES ('https://other.example/login', 'bob', X'${encrypt("unselected-secret")}', 0);`]);
    execFileSync("/usr/bin/sqlite3", [dbCookies, `CREATE TABLE meta (key TEXT, value INTEGER); INSERT INTO meta VALUES ('version', 24);
      CREATE TABLE cookies (host_key TEXT, top_frame_site_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, is_persistent INTEGER, samesite INTEGER);
      INSERT INTO cookies VALUES ('.example.com', '', 'sid', '', X'${encrypt("selected-cookie", ".example.com")}', '/', 0, 1, 1, 0, 1);
      INSERT INTO cookies VALUES ('other.example', '', 'sid', '', X'${encrypt("unselected-cookie", "other.example")}', '/', 0, 1, 1, 0, 1);`]);
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value).map((byte) => byte ^ 0xa5),
      decryptString: (value: Buffer) => Buffer.from(value).map((byte) => byte ^ 0xa5).toString(),
    };
    const vault = createBrowserPasswordVault({ dir: vaultDir, safeStorage });
    expect(await listChromiumSecretSources(home, "darwin")).toEqual(expect.arrayContaining([
      { id: "arc:Default", browser: "Arc", profile: "Default" },
    ]));
    expect(await previewChromiumSites(home, "arc:Default", "darwin")).toEqual([
      { host: "example.com", passwords: 1, cookies: 1 },
      { host: "other.example", passwords: 1, cookies: 1 },
    ]);
    const setCookies: Array<{ name: string; value: string }> = [];
    const result = await importChromiumSites({
      home, sourceId: "arc:Default", platform: "darwin", hosts: ["example.com"],
      getKeychainPassword: async (service) => { expect(service).toBe("Arc Safe Storage"); return secret; },
      vault, setCookie: async (cookie) => { setCookies.push(cookie); },
    });
    expect(result).toEqual({ passwords: 1, cookies: 1, skipped: 0 });
    expect(setCookies).toEqual([expect.objectContaining({ name: "sid", value: "selected-cookie" })]);
    expect(await vault.find("https://example.com", "alice")).toMatchObject({ password: "selected-secret" });
    expect(await vault.find("https://other.example", "bob")).toBeNull();
  });
});

describe("browser secret IPC contract", () => {
  it("accepts a selected site import and returns counts, never secret values", () => {
    const channels = INVOKE_CHANNELS as Record<string, { request: { safeParse: (value: unknown) => { success: boolean } }; response: { safeParse: (value: unknown) => { success: boolean } } }>;
    expect(channels["browser:import-sites"]?.request.safeParse({ sourceId: "arc:Default", hosts: ["example.com"] }).success).toBe(true);
    expect(channels["browser:import-sites"]?.request.safeParse({ sourceId: "arc:Default", hosts: ["../secret"] }).success).toBe(false);
    expect(channels["browser:import-sites"]?.response.safeParse({ passwords: 1, cookies: 2, skipped: 0 }).success).toBe(true);
    expect(channels["browser:import-sites"]?.response.safeParse({ passwords: 1, cookies: 2, skipped: 0, password: "leak" }).success).toBe(false);
    expect(channels["browser:import-1password"]?.request.safeParse({ ids: ["abcdefghijkl"] }).success).toBe(true);
    expect(channels["browser:delete-password"]?.request.safeParse({ origin: "https://example.com", username: "alice" }).success).toBe(true);
    expect(channels["browser:delete-password"]?.request.safeParse({ origin: "https://example.com", username: "alice", password: "leak" }).success).toBe(false);
    expect(channels["browser:export-passwords"]?.response.safeParse({ exported: true }).success).toBe(true);
  });
});
