import { describe, expect, it, vi } from "vitest";
import { CollaborationControlClient } from "../../packages/gateway/src/collaboration/control-client.js";

const runtimeId = "vps:11111111-1111-4111-8111-111111111111";
const logicalRuntimeId = runtimeId.replace(":", "-");
const success = (generation = 4) => Response.json({
  protocolVersion: 2,
  runtime: { runtimeId: logicalRuntimeId, authorityGeneration: generation, registeredAt: "2026-10-22T12:00:00.000Z" },
  platformSigningKeys: [{ keyId: "platform", algorithm: "ed25519", publicKey: "A".repeat(43) }],
  controlTicket: "t".repeat(43), relay: { origin: "https://app.matrix-os.com" },
});
const conflict = (runtime = { runtimeId: logicalRuntimeId, authorityGeneration: 4 }) => Response.json({
  error: "Collaboration state changed", protocolVersion: 2, runtime,
}, { status: 409 });

function client(fetchImpl: typeof fetch) {
  return new CollaborationControlClient({
    platformBaseUrl: "https://app.matrix-os.com", runtimeId,
    ownerId: "user_owner", relayHandle: "owner", serviceToken: "s".repeat(40),
    identity: { keyId: "home", publicKey: "B".repeat(43) },
    sessions: { revoke: () => undefined }, fetchImpl,
  });
}

describe("control registration after a gateway restart", () => {
  it("negotiates the exact higher generation once before committing keys or freshness", async () => {
    const generations: number[] = [];
    let control!: CollaborationControlClient;
    control = client(vi.fn(async (_url, init) => {
      generations.push(JSON.parse(String(init?.body)).authorityGeneration);
      expect(control.platformKeys()).toEqual([]);
      expect(control.controlFresh()).toBe(false);
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return generations.length === 1 ? conflict() : success();
    }));
    await expect(control.register()).resolves.toMatchObject({ runtime: { authorityGeneration: 4 } });
    expect(generations).toEqual([1, 4]);
    expect(control.authorityGeneration()).toBe(4);
    expect(control.controlFresh()).toBe(true);
    await control.shutdown();
  });

  it.each([
    { runtimeId: "vps-22222222-2222-4222-8222-222222222222", authorityGeneration: 4 },
    { runtimeId: logicalRuntimeId, authorityGeneration: 1 },
    { runtimeId: logicalRuntimeId, authorityGeneration: 0 },
    { runtimeId: logicalRuntimeId, authorityGeneration: 1.5 },
    { runtimeId: logicalRuntimeId, authorityGeneration: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects unrelated or invalid conflict metadata: %j", async (runtime) => {
    const fetchImpl = vi.fn(async () => conflict(runtime));
    const control = client(fetchImpl);
    await expect(control.register()).rejects.toBeInstanceOf(Error);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(control.authorityGeneration()).toBe(1);
    expect(control.platformKeys()).toEqual([]);
    expect(control.controlFresh()).toBe(false);
    await control.shutdown();
  });

  it.each([401, 403, 409, 429, 503])("does not retry a generic rejection (%s)", async (status) => {
    const fetchImpl = vi.fn(async () => Response.json({ error: "Collaboration unavailable" }, { status }));
    const control = client(fetchImpl);
    await expect(control.register()).rejects.toBeInstanceOf(Error);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(control.controlFresh()).toBe(false);
    await control.shutdown();
  });

  it("bounds negotiation even when the authoritative generation changes again", async () => {
    const fetchImpl = vi.fn(async () => conflict());
    const control = client(fetchImpl);
    await expect(control.register()).rejects.toBeInstanceOf(Error);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(control.platformKeys()).toEqual([]);
    expect(control.controlFresh()).toBe(false);
    await control.shutdown();
  });

  it("refuses a negotiated success that regresses the platform generation", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(conflict()).mockResolvedValueOnce(success(2));
    const control = client(fetchImpl);
    await expect(control.register()).rejects.toBeInstanceOf(Error);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(control.authorityGeneration()).toBe(1);
    expect(control.platformKeys()).toEqual([]);
    expect(control.controlFresh()).toBe(false);
    await control.shutdown();
  });

  it("bounds a conflict response before parsing its metadata", async () => {
    const fetchImpl = vi.fn(async () => new Response(" ".repeat(16 * 1024 + 1), { status: 409 }));
    const control = client(fetchImpl);
    await expect(control.register()).rejects.toThrow("too large");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(control.platformKeys()).toEqual([]);
    expect(control.controlFresh()).toBe(false);
    await control.shutdown();
  });

  it("does not negotiate after shutdown lands while the conflict is in flight", async () => {
    let control!: CollaborationControlClient;
    const fetchImpl = vi.fn(async () => { control.fence(); return conflict(); });
    control = client(fetchImpl);
    await expect(control.register()).rejects.toBeInstanceOf(Error);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(control.authorityGeneration()).toBe(1);
    expect(control.controlFresh()).toBe(false);
  });
});
