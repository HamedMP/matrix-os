import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, stat } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileHermesCredentialStore } from "../../packages/gateway/src/hermes/credential-store.js";

describe("Hermes credential store", () => {
  let homePath: string;

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "matrix-hermes-credentials-"));
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("stores model credentials server-side with owner-only permissions", async () => {
    const store = createFileHermesCredentialStore({ homePath });

    await store.writeModelCredential("user_123", "anthropic", "model_secret");

    await expect(store.hasModelCredential("user_123", "anthropic")).resolves.toBe(true);
    await expect(store.readModelCredential("user_123", "anthropic")).resolves.toBe("model_secret");
    const credentialDir = join(homePath, "system", "hermes-manager", "credentials");
    const [credentialFile] = await readdir(credentialDir);
    const file = await stat(join(credentialDir, credentialFile));
    expect(file.mode & 0o777).toBe(0o600);
  });

  it("rejects unsafe owner ids before touching the filesystem", async () => {
    const store = createFileHermesCredentialStore({ homePath });

    await expect(store.writeModelCredential("../other", "anthropic", "secret")).rejects.toThrow("Invalid owner identifier");
  });

  it("keeps owner and provider identifiers collision-safe", async () => {
    const store = createFileHermesCredentialStore({ homePath });

    await store.writeModelCredential("a.b", "c", "first_secret");
    await store.writeModelCredential("a", "b.c", "second_secret");

    await expect(store.readModelCredential("a.b", "c")).resolves.toBe("first_secret");
    await expect(store.readModelCredential("a", "b.c")).resolves.toBe("second_secret");
  });

  it("keeps credential filenames bounded for long Matrix identifiers", async () => {
    const store = createFileHermesCredentialStore({ homePath });
    const ownerId = `@${"a".repeat(250)}:m`;
    const providerId = "p".repeat(128);

    await store.writeModelCredential(ownerId, providerId, "long_secret");

    await expect(store.readModelCredential(ownerId, providerId)).resolves.toBe("long_secret");
    const credentialDir = join(homePath, "system", "hermes-manager", "credentials");
    const [credentialFile] = await readdir(credentialDir);
    expect(Buffer.byteLength(credentialFile, "utf8")).toBeLessThanOrEqual(255);
  });
});
