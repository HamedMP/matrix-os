import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, stat } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCompositeSymphonyCredentialStore,
  createFileSymphonyCredentialStore,
  encodeLinearIntegrationCredential,
} from "../../packages/gateway/src/symphony/credential-store.js";

describe("Symphony credential store", () => {
  let homePath: string;

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "matrix-symphony-credentials-"));
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("stores Linear credentials server-side with owner-only permissions", async () => {
    const store = createFileSymphonyCredentialStore({ homePath });

    await store.writeLinearCredential("user_123", "lin_api_secret");

    await expect(store.hasLinearCredential("user_123")).resolves.toBe(true);
    await expect(store.readLinearCredential("user_123")).resolves.toBe("lin_api_secret");
    const file = await stat(join(homePath, "system", "symphony", "credentials", "user_123.linear"));
    expect(file.mode & 0o777).toBe(0o600);
  });

  it("rejects unsafe owner ids before touching the filesystem", async () => {
    const store = createFileSymphonyCredentialStore({ homePath });

    await expect(store.writeLinearCredential("../other", "secret")).rejects.toThrow("Invalid owner identifier");
  });

  it("deletes credentials without exposing the prior secret", async () => {
    const store = createFileSymphonyCredentialStore({ homePath });
    await store.writeLinearCredential("user_123", "lin_api_secret");

    await store.deleteLinearCredential("user_123");

    await expect(store.hasLinearCredential("user_123")).resolves.toBe(false);
    await expect(store.readLinearCredential("user_123")).resolves.toBeNull();
  });

  it("falls back to an opaque Linear integration reference when no API key is stored", async () => {
    const primary = createFileSymphonyCredentialStore({ homePath });
    const hasLinearIntegration = vi.fn(async (ownerId: string) => ownerId === "user_123");
    const store = createCompositeSymphonyCredentialStore({ primary, hasLinearIntegration });

    await expect(store.hasLinearCredential("user_123")).resolves.toBe(true);
    await expect(store.readLinearCredential("user_123")).resolves.toBe(encodeLinearIntegrationCredential("user_123"));
    expect(hasLinearIntegration).toHaveBeenCalledWith("user_123");
  });

  it("prefers a stored Linear API key over the integration fallback", async () => {
    const primary = createFileSymphonyCredentialStore({ homePath });
    await primary.writeLinearCredential("user_123", "lin_api_secret");
    const store = createCompositeSymphonyCredentialStore({
      primary,
      hasLinearIntegration: vi.fn(async () => true),
    });

    await expect(store.readLinearCredential("user_123")).resolves.toBe("lin_api_secret");
  });
});
