import { generateKeyPair } from "node:crypto";
import { promisify } from "node:util";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
  BrowserHandoffReplayStore,
  signBrowserHandoffToken,
  verifyBrowserHandoffToken,
} from "../../packages/gateway/src/handoff-token.js";
import {
  buildBrowserHandoffRedirectUrl,
  isBrowserOwnerHostAllowed,
  normalizeBrowserHandoffTarget,
  signPlatformBrowserHandoff,
} from "../../packages/platform/src/browser-handoff.js";

const generateRsa = promisify(generateKeyPair);

async function keys() {
  const pair = await generateRsa("rsa", { modulusLength: 2048 });
  return pair;
}

describe("Browser platform handoff tokens", () => {
  it("verifies asymmetric platform-signed one-use handoff tokens", async () => {
    const { privateKey, publicKey } = await keys();
    const token = await signBrowserHandoffToken({
      privateKey,
      keyId: "browser-key-1",
      ownerId: "owner_1",
      deviceId: "device_1",
      target: "https://example.com/",
      nonce: "nonce_1",
      now: 1_000,
    });

    await expect(verifyBrowserHandoffToken({
      token,
      publicKey,
      expectedOwnerId: "owner_1",
      replayStore: new BrowserHandoffReplayStore(),
      now: new Date(2_000),
    })).resolves.toMatchObject({
      ownerId: "owner_1",
      deviceId: "device_1",
      target: "https://example.com/",
      nonce: "nonce_1",
    });
  });

  it("rejects owner mismatch and replayed nonces", async () => {
    const { privateKey, publicKey } = await keys();
    const token = await signBrowserHandoffToken({
      privateKey,
      keyId: "browser-key-1",
      ownerId: "owner_1",
      deviceId: "device_1",
      target: "https://example.com/",
      nonce: "nonce_2",
      now: 1_000,
    });
    const replayStore = new BrowserHandoffReplayStore();

    await expect(verifyBrowserHandoffToken({
      token,
      publicKey,
      expectedOwnerId: "owner_2",
      replayStore,
      now: new Date(2_000),
    })).rejects.toThrow("invalid_handoff");

    await verifyBrowserHandoffToken({ token, publicKey, expectedOwnerId: "owner_1", replayStore, now: new Date(2_000) });
    await expect(verifyBrowserHandoffToken({
      token,
      publicKey,
      expectedOwnerId: "owner_1",
      replayStore,
      now: new Date(2_000),
    })).rejects.toThrow("invalid_handoff_replay");
  });

  it("keeps live handoff nonces until expiry and fails closed when full", () => {
    const replayStore = new BrowserHandoffReplayStore();
    for (let index = 0; index < 10_000; index += 1) {
      expect(replayStore.seen(`nonce_${index}`, 60_000, 1_000)).toBe(false);
    }

    expect(() => replayStore.seen("nonce_overflow", 60_000, 1_000)).toThrow("invalid_handoff_replay");
    expect(replayStore.seen("nonce_after_expiry", 120_000, 61_000)).toBe(false);
  });

  it("rejects shared-secret HS256 tokens", async () => {
    const { publicKey } = await keys();
    const token = await new SignJWT({
      ownerId: "owner_1",
      deviceId: "device_1",
      target: "https://example.com/",
      nonce: "nonce_3",
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer("matrix-os-platform")
      .setAudience("matrix-browser-handoff")
      .setIssuedAt(1)
      .setExpirationTime(61)
      .sign(new TextEncoder().encode("shared-secret"));

    await expect(verifyBrowserHandoffToken({
      token,
      publicKey,
      expectedOwnerId: "owner_1",
      now: new Date(2_000),
    })).rejects.toThrow();
  });

  it("platform handoff redirects to the owner VPS browser route instead of proxying target content", async () => {
    const { privateKey, publicKey } = await keys();
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const token = await signPlatformBrowserHandoff({
      privateKeyPem,
      keyId: "browser-key-1",
      ownerId: "owner_1",
      deviceId: "device_1",
      target: normalizeBrowserHandoffTarget("/browser/google.com"),
      now: 1_000,
    });

    const redirectUrl = buildBrowserHandoffRedirectUrl({
      machine: {
        publicIPv4: "203.0.113.10",
        status: "running",
      },
      targetPath: "/browser/google.com",
      token,
    });

    expect(redirectUrl).toMatch(/^https:\/\/203\.0\.113\.10\/browser\/google\.com\?handoff=/);
    const handoff = new URL(redirectUrl!).searchParams.get("handoff");
    await expect(verifyBrowserHandoffToken({
      token: handoff!,
      publicKey,
      expectedOwnerId: "owner_1",
      replayStore: new BrowserHandoffReplayStore(),
      now: new Date(2_000),
    })).resolves.toMatchObject({
      ownerId: "owner_1",
      deviceId: "device_1",
      target: "https://google.com/",
    });
  });

  it("enforces an optional owner host allowlist for handoff redirects", () => {
    expect(isBrowserOwnerHostAllowed("alice.matrix-os.com", ["*.matrix-os.com"])).toBe(true);
    expect(isBrowserOwnerHostAllowed("203.0.113.10", ["203.0.113.10"])).toBe(true);
    expect(isBrowserOwnerHostAllowed("evil.example.com", ["*.matrix-os.com"])).toBe(false);
    expect(buildBrowserHandoffRedirectUrl({
      machine: { publicIPv4: "203.0.113.10", status: "running" },
      targetPath: "/browser/example.com",
      token: "token",
      ownerHostAllowlist: ["198.51.100.10"],
    })).toBeNull();
  });
});
