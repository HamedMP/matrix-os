import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CollaborationActorProofVerifier } from "../../packages/gateway/src/collaboration/actor-proof.js";
import {
  CollaborationPolicyClient,
  CollaborationPolicyClientError,
} from "../../packages/gateway/src/collaboration/policy-client.js";
const now = new Date("2026-09-10T00:00:00.000Z");
const key = "policy-test-key-0123456789abcdef0123456789";
function signedPolicy(overrides: Record<string, unknown> = {}) {
  const policy = {
    milestone: "m2",
    revision: "7",
    mode: "enabled",
    cohort: [],
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 30_000).toISOString(),
    ...overrides,
  };
  return {
    policy,
    keyId: "key-1",
    signature: createHmac("sha256", key)
      .update(`policy\n${JSON.stringify(policy)}`)
      .digest("base64url"),
  };
}
function client(fetchImpl: typeof fetch) {
  return new CollaborationPolicyClient({
    platformBaseUrl: "https://platform.example",
    runtimeId: "runtime_owner",
    serviceToken: "runtime-service-token-0123456789abcdef",
    verifier: new CollaborationActorProofVerifier({
      runtimeId: "runtime_owner",
      keys: { "key-1": key },
      now: () => now,
    }),
    fetchImpl,
  });
}
describe("collaboration policy client", () => {
  it("fetches and verifies a fresh signed M2 policy with bounded transport", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(signedPolicy()), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await expect(client(fetchImpl).getM2()).resolves.toMatchObject({
      milestone: "m2",
      revision: "7",
      mode: "enabled",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://platform.example/internal/collaboration/policy?milestone=m2",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        signal: expect.any(AbortSignal),
        headers: expect.objectContaining({
          authorization: "Bearer runtime-service-token-0123456789abcdef",
          "x-matrix-runtime-id": "runtime_owner",
        }),
      }),
    );
  });
  it.each([
    ["unsigned response", { ...signedPolicy(), signature: "a".repeat(43) }],
    ["wrong milestone", signedPolicy({ milestone: "m1" })],
  ])("fails closed for %s", async (_label, body) => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    await expect(client(fetchImpl).getM2()).rejects.toBeInstanceOf(CollaborationPolicyClientError);
  });
  it("caps the policy response before parsing", async () => {
    const fetchImpl = vi.fn(async () => new Response("x".repeat(20_000), {
      status: 200,
      headers: { "content-length": "20000" },
    }));
    await expect(client(fetchImpl).getM2()).rejects.toBeInstanceOf(CollaborationPolicyClientError);
  });
});
