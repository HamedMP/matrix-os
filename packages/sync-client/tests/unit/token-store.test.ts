import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  clearAuth,
  loadAuth,
  saveAuth,
  saveAuthToMacKeychain,
} from "../../src/auth/token-store.js";

const AUTH = {
  accessToken: "access-token",
  refreshToken: "refresh-token",
  expiresAt: 1_800_000_000_000,
  userId: "user_123",
  handle: "alice",
  runtimeSlot: "primary",
};

describe("saveAuth", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "matrix-sync-auth-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates auth.json with owner-only permissions", async () => {
    const authPath = join(tempDir, "private", "auth.json");

    await saveAuth({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: Date.now() + 60_000,
      userId: "user_123",
      handle: "alice",
    }, authPath);

    expect(JSON.parse(await readFile(authPath, "utf-8")).accessToken).toBe("access-token");
    expect((await stat(join(tempDir, "private"))).mode & 0o777).toBe(0o700);
    expect((await stat(authPath)).mode & 0o777).toBe(0o600);
  });

  it("stores only a Keychain reference on macOS and resolves it for the daemon", async () => {
    const authPath = join(tempDir, "private", "auth.json");
    const keychain = {
      get: vi.fn(async () => AUTH),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };

    await saveAuthToMacKeychain(AUTH, authPath, {
      platform: "darwin",
      keychain,
      randomId: () => "18e9ee9f-ec1f-45b7-b0c2-b51a47e6da8c",
    });

    const stored = JSON.parse(await readFile(authPath, "utf8"));
    expect(stored).toEqual({
      schemaVersion: 1,
      credentialStore: "macos-keychain",
      account: "18e9ee9f-ec1f-45b7-b0c2-b51a47e6da8c",
    });
    expect(JSON.stringify(stored)).not.toContain(AUTH.accessToken);
    await expect(loadAuth(authPath, { platform: "darwin", keychain })).resolves.toEqual(AUTH);
  });

  it("updates and clears an existing Keychain-backed credential without writing tokens to disk", async () => {
    const authPath = join(tempDir, "private", "auth.json");
    const keychain = {
      get: vi.fn(async () => AUTH),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const options = {
      platform: "darwin" as const,
      keychain,
      randomId: () => "18e9ee9f-ec1f-45b7-b0c2-b51a47e6da8c",
    };
    await saveAuthToMacKeychain(AUTH, authPath, options);

    const rotated = { ...AUTH, accessToken: "rotated-access" };
    await saveAuth(rotated, authPath, options);
    expect(keychain.set).toHaveBeenLastCalledWith(options.randomId(), rotated);
    expect(await readFile(authPath, "utf8")).not.toContain("rotated-access");

    await clearAuth(authPath, options);
    expect(keychain.delete).toHaveBeenCalledWith(options.randomId());
    await expect(readFile(authPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("re-enrolls into the existing Keychain item instead of orphaning a second secret", async () => {
    const authPath = join(tempDir, "private", "auth.json");
    const keychain = {
      get: vi.fn(async () => AUTH),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const options = {
      platform: "darwin" as const,
      keychain,
      randomId: vi.fn(() => "18e9ee9f-ec1f-45b7-b0c2-b51a47e6da8c"),
    };
    await saveAuthToMacKeychain(AUTH, authPath, options);
    await saveAuthToMacKeychain({ ...AUTH, accessToken: "re-enrolled" }, authPath, options);

    expect(options.randomId).toHaveBeenCalledOnce();
    expect(keychain.set).toHaveBeenLastCalledWith(
      "18e9ee9f-ec1f-45b7-b0c2-b51a47e6da8c",
      { ...AUTH, accessToken: "re-enrolled" },
    );
    expect(await readFile(authPath, "utf8")).not.toContain("re-enrolled");
  });
});
