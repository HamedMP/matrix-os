import { describe, expect, it, vi } from "vitest";
import { createCompatibleDirectBuildVerifier } from "../../packages/platform/src/collaboration/compatible-build.js";

const machineId = "11111111-1111-4111-8111-111111111111";
const request = { scopeId: "10000000-0000-4000-8000-000000000001", runtimeId: `vps:${machineId}`, ownerId: "owner-a", targetGeneration: 2 };
const version = "v124-test";
const gitCommit = "a".repeat(40);
const sha256 = "b".repeat(64);

function fixture(overrides: Record<string, unknown> = {}) {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
    runtime: { machineId },
    capabilities: { collaboration: true, collaborationDirectProtocolVersion: 2 },
    release: { version, gitCommit, sha256 },
    ...overrides,
  }), { headers: { "content-type": "application/json", "cache-control": "no-store" } }));
  const resolveMachine = vi.fn(async () => ({ machineId, clerkUserId: "owner-a", handle: "owner-home", publicIPv4: "192.0.2.10", status: "running" }));
  const getPublishedRelease = vi.fn(async () => ({ version, gitCommit, sha256 }));
  const verify = createCompatibleDirectBuildVerifier({
    resolveMachine, getPublishedRelease, fetchImpl: fetchImpl as typeof fetch,
    platformSecret: "platform-secret",
  });
  return { verify, fetchImpl, resolveMachine, getPublishedRelease };
}

describe("S18 compatible direct build proof", () => {
  it("checks the exact enrolled owner, fresh protocol marker, and published release digest before rollback", async () => {
    const subject = fixture();
    expect(await subject.verify(request)).toBe(true);
    expect(subject.fetchImpl).toHaveBeenCalledWith("https://192.0.2.10:443/api/system/info", expect.objectContaining({
      method: "GET", cache: "no-store", redirect: "error", signal: expect.any(AbortSignal),
    }));
    expect(subject.getPublishedRelease).toHaveBeenCalledWith(version);
  });

  it.each([
    { runtime: { machineId: "22222222-2222-4222-8222-222222222222" } },
    { capabilities: { collaboration: true } },
    { capabilities: { collaboration: true, collaborationDirectProtocolVersion: 1 } },
    { release: { version, gitCommit, sha256: "c".repeat(64) } },
    { release: { version, gitCommit: "c".repeat(40), sha256 } },
  ])("rejects absent or mismatched installed proof %#", async (response) => {
    expect(await fixture(response).verify(request)).toBe(false);
  });

  it("fails closed when the owner is offline or the published release is absent", async () => {
    const offline = fixture();
    offline.resolveMachine.mockResolvedValueOnce({ machineId, clerkUserId: "owner-a", handle: "owner-home", publicIPv4: "192.0.2.10", status: "stopped" });
    expect(await offline.verify(request)).toBe(false);
    expect(offline.fetchImpl).not.toHaveBeenCalled();

    const unpublished = fixture();
    unpublished.getPublishedRelease.mockResolvedValueOnce(null);
    expect(await unpublished.verify(request)).toBe(false);
  });
});
