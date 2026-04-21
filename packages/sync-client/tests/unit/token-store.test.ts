import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveAuth } from "../../src/auth/token-store.js";

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
});
