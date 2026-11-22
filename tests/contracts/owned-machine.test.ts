import { describe, expect, it } from "vitest";
import {
  OWNED_MACHINE_ENV_KEYS,
  OwnedComputerUpdateRequestSchema,
  OwnedEnrollPollResponseSchema,
  OwnedEnrollStartRequestSchema,
  OwnedMachineEnvSchema,
  OwnedMachineUserCodeSchema,
} from "../../packages/contracts/src/index.js";

function env(overrides: Record<string, string> = {}): Record<string, string> {
  return { ...Object.fromEntries(OWNED_MACHINE_ENV_KEYS.map((key) => [key, "value"])), ...overrides };
}

describe("owned machine contract", () => {
  it("normalizes a typed user code and rejects ambiguous letters", () => {
    expect(OwnedMachineUserCodeSchema.parse(" bcdf-ghjk ")).toBe("BCDFGHJK");
    expect(OwnedMachineUserCodeSchema.safeParse("BCDF-GHJ1").success).toBe(false);
    expect(OwnedMachineUserCodeSchema.safeParse("ABCD-EFGH").success).toBe(false);
  });

  it("accepts a machine report and rejects control characters and unknown fields", () => {
    const report = { hostname: "lab-1", os: "Ubuntu 24.04", arch: "x86_64", agentVersion: "1.2.3" };
    expect(OwnedEnrollStartRequestSchema.parse(report)).toEqual(report);
    expect(OwnedEnrollStartRequestSchema.safeParse({ ...report, hostname: "a\nb" }).success).toBe(false);
    expect(OwnedEnrollStartRequestSchema.safeParse({ ...report, extra: 1 }).success).toBe(false);
  });

  it("delivers only allowlisted environment keys with shell-safe values", () => {
    expect(OwnedMachineEnvSchema.safeParse(env()).success).toBe(true);
    expect(OwnedMachineEnvSchema.safeParse({ ...env(), DATABASE_URL: "x" }).success).toBe(false);
    expect(OwnedMachineEnvSchema.safeParse(env({ UPGRADE_TOKEN: "a$(id)" })).success).toBe(false);
    expect(OwnedMachineEnvSchema.safeParse(env({ UPGRADE_TOKEN: "a\nB=1" })).success).toBe(false);
    expect(OWNED_MACHINE_ENV_KEYS).not.toContain("PIPEDREAM_CLIENT_SECRET");
  });

  it("parses each poll outcome", () => {
    expect(OwnedEnrollPollResponseSchema.parse({ status: "pending" }).status).toBe("pending");
    const ready = OwnedEnrollPollResponseSchema.parse({
      status: "ready",
      machineId: "4f7c2d1e-5a6b-4c3d-8e9f-0a1b2c3d4e5f",
      tunnelToken: "eyJhIjoiYiJ9",
      env: env(),
    });
    expect(ready.status).toBe("ready");
  });

  it("requires at least one field in a computer update", () => {
    expect(OwnedComputerUpdateRequestSchema.safeParse({}).success).toBe(false);
    expect(OwnedComputerUpdateRequestSchema.safeParse({ name: "Lab" }).success).toBe(true);
  });
});
