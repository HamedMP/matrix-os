import { describe, it, expect, beforeEach, vi } from "vitest";
import { createPlatformDb, type PlatformDB } from "../../packages/platform/src/db.js";
import {
  createDeviceFlow,
  USER_CODE_ALPHABET,
  formatUserCode,
  normalizeUserCode,
  type DeviceFlow,
} from "../../packages/platform/src/device-flow.js";

const VERIFY_BASE = "http://localhost:9000";

function newDb(): PlatformDB {
  return createPlatformDb(":memory:");
}

describe("device flow: code generation", () => {
  let db: PlatformDB;
  let flow: DeviceFlow;
  let now: number;

  beforeEach(() => {
    db = newDb();
    now = 1_000_000_000_000;
    flow = createDeviceFlow({
      db,
      now: () => now,
      verificationBase: VERIFY_BASE,
    });
  });

  it("issues an 8-character user_code from the RFC 8628 consonant alphabet", async () => {
    const issued = await flow.createDeviceCode();
    const raw = normalizeUserCode(issued.userCode);

    expect(raw).toHaveLength(8);
    for (const ch of raw) {
      expect(USER_CODE_ALPHABET).toContain(ch);
    }
  });

  it("formats user_code as XXXX-XXXX in the response", async () => {
    const issued = await flow.createDeviceCode();
    expect(issued.userCode).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
  });

  it("issues a 32-byte base64url device_code", async () => {
    const issued = await flow.createDeviceCode();
    expect(issued.deviceCode).toMatch(/^[A-Za-z0-9_-]+$/);
    // base64url(32 bytes) = ceil(32 * 4 / 3) = 43 chars (no padding)
    expect(issued.deviceCode.length).toBe(43);
  });

  it("returns expiresIn=900 and interval=5 by default", async () => {
    const issued = await flow.createDeviceCode();
    expect(issued.expiresIn).toBe(900);
    expect(issued.interval).toBe(5);
  });

  it("verificationUri includes the user_code as a query param", async () => {
    const issued = await flow.createDeviceCode();
    expect(issued.verificationUri).toBe(
      `${VERIFY_BASE}/auth/device?user_code=${issued.userCode}`,
    );
  });
});

describe("device flow: polling", () => {
  let db: PlatformDB;
  let flow: DeviceFlow;
  let now: number;

  beforeEach(() => {
    db = newDb();
    now = 1_000_000_000_000;
    flow = createDeviceFlow({
      db,
      now: () => now,
      verificationBase: VERIFY_BASE,
      issueToken: async ({ clerkUserId }) => ({
        token: `jwt-for-${clerkUserId}`,
        expiresAt: now + 30 * 24 * 3_600_000,
        handle: clerkUserId.replace("user_", "@"),
      }),
    });
  });

  it("returns pending before approval", async () => {
    const issued = await flow.createDeviceCode();
    now += 5_000;
    const result = await flow.pollDeviceCode(issued.deviceCode);
    expect(result.status).toBe("pending");
  });

  it("returns slow_down when polled before the interval elapses", async () => {
    const issued = await flow.createDeviceCode();
    now += 5_000;
    await flow.pollDeviceCode(issued.deviceCode);
    now += 1_000; // only 1s after the previous poll, well under the 5s interval
    const result = await flow.pollDeviceCode(issued.deviceCode);
    expect(result.status).toBe("slow_down");
  });

  it("returns expired_token after expiresIn elapses", async () => {
    const issued = await flow.createDeviceCode();
    now += 901_000;
    const result = await flow.pollDeviceCode(issued.deviceCode);
    expect(result.status).toBe("expired");
  });

  it("returns approved with token after approveDeviceCode", async () => {
    const issued = await flow.createDeviceCode();
    await flow.approveDeviceCode(issued.userCode, "user_alice");
    now += 5_000;
    const result = await flow.pollDeviceCode(issued.deviceCode);

    expect(result.status).toBe("approved");
    expect(result.token).toBe("jwt-for-user_alice");
  });

  it("consumes the approved device code before awaiting token issuance", async () => {
    let resolveIssue: (() => void) | null = null;
    flow = createDeviceFlow({
      db,
      now: () => now,
      verificationBase: VERIFY_BASE,
      issueToken: async ({ clerkUserId }) => {
        await new Promise<void>((resolve) => {
          resolveIssue = resolve;
        });
        return {
          token: `jwt-for-${clerkUserId}`,
          expiresAt: now + 30 * 24 * 3_600_000,
          handle: clerkUserId.replace("user_", "@"),
        };
      },
    });

    const issued = await flow.createDeviceCode();
    await flow.approveDeviceCode(issued.userCode, "user_alice");
    now += 5_000;
    const firstPoll = flow.pollDeviceCode(issued.deviceCode);
    now += 5_000;

    await expect(flow.pollDeviceCode(issued.deviceCode)).resolves.toEqual({ status: "expired" });

    resolveIssue?.();
    await expect(firstPoll).resolves.toMatchObject({
      status: "approved",
      token: "jwt-for-user_alice",
    });
  });

  it("treats an unknown device_code as expired (cleanup-friendly)", async () => {
    const result = await flow.pollDeviceCode("does-not-exist");
    expect(result.status).toBe("expired");
  });
});

describe("device flow: approval", () => {
  let db: PlatformDB;
  let flow: DeviceFlow;
  let now: number;

  beforeEach(() => {
    db = newDb();
    now = 1_000_000_000_000;
    flow = createDeviceFlow({
      db,
      now: () => now,
      verificationBase: VERIFY_BASE,
      issueToken: async ({ clerkUserId }) => ({
        token: `jwt-${clerkUserId}`,
        expiresAt: now + 100,
        handle: clerkUserId,
      }),
    });
  });

  it("approveDeviceCode tolerates the dashed user_code form", async () => {
    const issued = await flow.createDeviceCode();
    await flow.approveDeviceCode(issued.userCode, "user_alice");
    now += 5_000;
    const result = await flow.pollDeviceCode(issued.deviceCode);
    expect(result.status).toBe("approved");
  });

  it("approveDeviceCode tolerates the undashed user_code form", async () => {
    const issued = await flow.createDeviceCode();
    await flow.approveDeviceCode(normalizeUserCode(issued.userCode), "user_bob");
    now += 5_000;
    const result = await flow.pollDeviceCode(issued.deviceCode);
    expect(result.status).toBe("approved");
  });

  it("approveDeviceCode is case-insensitive on user_code", async () => {
    const issued = await flow.createDeviceCode();
    await flow.approveDeviceCode(issued.userCode.toLowerCase(), "user_carol");
    now += 5_000;
    const result = await flow.pollDeviceCode(issued.deviceCode);
    expect(result.status).toBe("approved");
  });

  it("rejects approval by a different user after the device code is already approved", async () => {
    const issued = await flow.createDeviceCode();
    await flow.approveDeviceCode(issued.userCode, "user_alice");

    await expect(
      flow.approveDeviceCode(issued.userCode, "user_bob"),
    ).rejects.toThrow("Device code already approved");
  });

  it("approveDeviceCode throws for an unknown user_code", async () => {
    await expect(
      flow.approveDeviceCode("ZZZZ-ZZZZ", "user_alice"),
    ).rejects.toThrow();
  });

  it("approveDeviceCode throws for an expired user_code", async () => {
    const issued = await flow.createDeviceCode();
    now += 901_000;
    await expect(
      flow.approveDeviceCode(issued.userCode, "user_alice"),
    ).rejects.toThrow();
  });
});

describe("formatUserCode", () => {
  it("inserts a dash after the 4th character", () => {
    expect(formatUserCode("BCDFGHJK")).toBe("BCDF-GHJK");
  });
});

describe("normalizeUserCode", () => {
  it("strips dashes and uppercases", () => {
    expect(normalizeUserCode("bcdf-ghjk")).toBe("BCDFGHJK");
  });

  it("strips internal whitespace", () => {
    expect(normalizeUserCode(" BCDF GHJK ")).toBe("BCDFGHJK");
  });
});
