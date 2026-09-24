/** S19/T094: bounded synthetic relay accounting under concurrent workloads. */
import { describe, expect, it, vi } from "vitest";
import { OrganizationMembershipClient } from "../../packages/gateway/src/collaboration/organization-membership-client.js";
import { CollaborationRelay, type RelayMetadata } from "../../packages/platform/src/collaboration/relay.js";

const scopeId = "10000000-0000-4000-8000-000000000001";
const runtimeId = "vps-11111111-1111-4111-8111-111111111111";
const origin = "https://home.invalid";
const encoder = new TextEncoder();

function chunks(bytes: number): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes / 2));
      controller.enqueue(new Uint8Array(bytes / 2));
      controller.close();
    },
  });
}

describe("S19 synthetic relay traffic profile", () => {
  it("accounts for scope-read metadata separately from concurrent Chat, PTY and file bytes", async () => {
    const metadata: RelayMetadata[] = [];
    let directoryLookups = 0;
    const relay = new CollaborationRelay({
      resolveScopeHome: async (id) => {
        directoryLookups += 1;
        return id === scopeId ? { runtimeId, origin } : null;
      },
      resolveInvitationHome: async () => null,
      resolveRuntimeHome: async () => null,
      resolveSessionHome: async () => null,
      fetchImpl: (async (url: string, init: RequestInit) => {
        if (init.body) await new Response(init.body).arrayBuffer();
        const path = new URL(url).pathname;
        const size = path.endsWith("/discussion/messages") ? 2_048
          : path.endsWith("/terminal/input") ? 4_096
          : path.endsWith("/resources/file/content") ? 65_536 : 128;
        return new Response(new Uint8Array(size), { status: 200 });
      }) as never,
      onMetadata: (entry) => { metadata.push(entry); },
    });
    const base = `/api/collaboration/scopes/${scopeId}`;
    const request = async (suffix: string, body: Uint8Array | ReadableStream<Uint8Array> | null) => {
      const response = await relay.forward({
        actorId: "user_member", method: body ? "POST" : "GET", path: `${base}${suffix}`, query: "",
        headers: new Headers(), body,
      });
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    };
    await Promise.all(Array.from({ length: 10 }, async () => Promise.all([
      request("", null),
      request("/discussion/messages", encoder.encode("c".repeat(512))),
      request("/terminal/input", encoder.encode("p".repeat(256))),
      request("/resources/file/content", chunks(8_192)),
    ])));

    const scopeReads = metadata.filter((entry) => entry.path === base);
    const resource = metadata.filter((entry) => entry.path !== base);
    const sum = (rows: RelayMetadata[], field: "requestBytes" | "responseBytes") => rows.reduce((total, row) => total + row[field], 0);
    const profile = {
      requests: metadata.length,
      directoryLookups,
      scopeReadMetadataEvents: scopeReads.length,
      scopeReadResponseBytes: sum(scopeReads, "responseBytes"),
      relayedRequestBytes: sum(resource, "requestBytes"),
      relayedResponseBytes: sum(resource, "responseBytes"),
    };
    expect(profile).toEqual({
      requests: 40, directoryLookups: 40, scopeReadMetadataEvents: 10, scopeReadResponseBytes: 1_280,
      relayedRequestBytes: 89_600, relayedResponseBytes: 716_800,
    });
    expect(metadata).toHaveLength(40);
    expect(metadata.every((entry) => entry.outcome === "forwarded" && entry.runtimeId === runtimeId)).toBe(true);
    expect(JSON.stringify(metadata)).not.toContain("cccccccc");
    expect(JSON.stringify(metadata)).not.toContain("pppppppp");
    console.info("[S19 synthetic relay profile]", JSON.stringify(profile));
  });

  it("coalesces one hundred concurrent membership checks into one platform control request", async () => {
    const now = new Date("2026-09-21T14:00:00.000Z");
    const organizationId = "org_profile";
    const actorId = "user_profile";
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([{
      protocolVersion: 2, type: "membership_assertion", organizationId, actorId,
      membershipEpoch: "1", member: true, aiSubmission: "members",
      requestStartedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 20_000).toISOString(),
    }]), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new OrganizationMembershipClient({
      platformBaseUrl: "https://platform.invalid", runtimeId, serviceToken: "t".repeat(40),
      fetchImpl: fetchImpl as unknown as typeof fetch, now: () => now,
    });
    const assertions = await Promise.all(Array.from({ length: 100 }, () => client.assertMembership({ organizationId, actorId })));
    expect(assertions).toHaveLength(100);
    expect(assertions.every((entry) => entry.member && entry.membershipEpoch === "1")).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    console.info("[S19 synthetic control profile]", JSON.stringify({ membershipChecks: 100, platformRequests: fetchImpl.mock.calls.length }));
  });

  it("records one directory lookup and one metadata event per streamed PTY exchange, never per chunk", async () => {
    const metadata: RelayMetadata[] = [];
    let directoryLookups = 0;
    const chunkCount = 64;
    const chunkBytes = 1_024;
    const streamed = () => new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < chunkCount; index += 1) controller.enqueue(new Uint8Array(chunkBytes));
        controller.close();
      },
    });
    const relay = new CollaborationRelay({
      resolveScopeHome: async (id) => {
        directoryLookups += 1;
        return id === scopeId ? { runtimeId, origin } : null;
      },
      resolveInvitationHome: async () => null,
      resolveRuntimeHome: async () => null,
      resolveSessionHome: async () => null,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        if (init.body) await new Response(init.body).arrayBuffer();
        return new Response(streamed(), { status: 200 });
      }) as never,
      onMetadata: (entry) => { metadata.push(entry); },
    });
    const response = await relay.forward({
      actorId: "user_member", method: "POST", path: `/api/collaboration/scopes/${scopeId}/terminal/input`, query: "",
      headers: new Headers(), body: streamed(),
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let receivedChunks = 0;
    let receivedBytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedChunks += 1;
      receivedBytes += value.byteLength;
    }
    expect(receivedBytes).toBe(chunkCount * chunkBytes);
    expect(receivedChunks).toBeGreaterThan(1);
    expect(directoryLookups).toBe(1);
    expect(metadata).toHaveLength(1);
    expect(metadata[0]).toMatchObject({
      outcome: "forwarded", runtimeId, requestBytes: chunkCount * chunkBytes, responseBytes: chunkCount * chunkBytes,
    });
    console.info("[S19 synthetic chunk profile]", JSON.stringify({
      chunks: receivedChunks, bytes: receivedBytes, directoryLookups, metadataEvents: metadata.length,
    }));
  });

  it("bounds relayed socket connections per home and releases capacity exactly once", async () => {
    const relay = new CollaborationRelay({
      resolveScopeHome: async (id) => (id === scopeId ? { runtimeId, origin } : null),
      resolveInvitationHome: async () => null,
      resolveRuntimeHome: async () => null,
      resolveSessionHome: async () => null,
      fetchImpl: (async () => new Response(null, { status: 204 })) as never,
      limits: { connectionsPerHome: 2, connectionsPerActor: 5 },
    });
    const prepare = (actorId: string) => relay.prepareSocket({
      actorId, rawPath: `/ws/collaboration/direct/scopes/${scopeId}/terminal?ticket=abc`,
      incomingHeaders: { upgrade: "websocket" }, externalHost: "app.matrix-os.com",
    });
    const first = await prepare("user_a");
    const second = await prepare("user_b");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(await prepare("user_c")).toBeNull();
    expect(relay.connectionCounts()).toEqual({ homes: 2, actors: 2 });

    first!.release();
    first!.release();
    expect(relay.connectionCounts()).toEqual({ homes: 1, actors: 1 });
    const third = await prepare("user_c");
    expect(third).not.toBeNull();
    expect(relay.connectionCounts()).toEqual({ homes: 2, actors: 2 });

    second!.release();
    third!.release();
    expect(relay.connectionCounts()).toEqual({ homes: 0, actors: 0 });
  });
});
