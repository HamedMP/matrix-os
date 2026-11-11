import { describe, expect, it, vi } from "vitest";

import { createCollaborativeAppLaunchUpstreamFactory } from "../../packages/platform/src/collaboration/app-launch-upstream.js";
import { proofKeyThumbprint } from "../../packages/platform/src/collaboration/ticket-crypto.js";

const now = new Date("2026-11-05T10:00:00.000Z");
const actorId = "user_member";
const scopeId = "10000000-0000-4000-8000-000000000001";
const organizationId = "org_matrix_team";
const sessionId = "90000000-0000-4000-8000-000000000001";

describe("collaborative app owner-session renewal", () => {
  it("renews the proof-bound direct session before repeated and concurrent assets exhaust its action budget", async () => {
    let ticketCount = 0;
    let latestThumbprint = "";
    let actionsRemaining = 0;
    let releaseSlow: (() => void) | undefined;
    const issuer = { issue: vi.fn(async ({ actorId: requestedActor, request }: {
      actorId: string;
      request: { proofPublicKey: string };
    }) => {
      ticketCount++;
      latestThumbprint = proofKeyThumbprint(request.proofPublicKey);
      return {
        signedTicket: { ticket: {
          protocolVersion: 2,
          ticketId: `80000000-0000-4000-8000-${String(ticketCount).padStart(12, "0")}`,
          nonce: ticketCount.toString(16).repeat(64),
          actorId: requestedActor,
          organizationId,
          resource: { scopeId, kind: "app_instance" },
          purpose: "direct_session",
          runtime: { runtimeId: "runtime_owner", authorityGeneration: 1 },
          proofKeyThumbprint: latestThumbprint,
          maxActions: 4,
          issuedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 30_000).toISOString(),
        }, keyId: "platform-key", signature: "s".repeat(86) },
        endpoint: { origin: "https://app.matrix-os.com", protocolVersion: 2 },
      };
    }) };
    const relay = { forward: vi.fn(async (input: { method: string; path: string; body?: Uint8Array }) => {
      if (input.path === "/api/collaboration/direct-sessions" || input.path === `/api/collaboration/direct-sessions/${sessionId}/renew`) {
        actionsRemaining = 4;
        return new Response(JSON.stringify({
          protocolVersion: 2, id: sessionId, actorId, organizationId, scopeId,
          runtimeId: "runtime_owner", authorityGeneration: 1, purpose: "direct_session",
          proofKeyThumbprint: latestThumbprint,
          issuedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 300_000).toISOString(),
          evidenceExpiresAt: new Date(now.getTime() + 20_000).toISOString(),
          renewAfter: new Date(now.getTime() + 240_000).toISOString(),
        }), { status: input.path.endsWith("/renew") ? 200 : 201,
          headers: { "content-type": "application/json" } });
      }
      if (input.method === "GET" && input.path.endsWith("/slow.js")) {
        return new Promise<Response>((resolve) => {
          releaseSlow = () => {
            if (actionsRemaining < 1) resolve(new Response(null, { status: 429 }));
            else { actionsRemaining--; resolve(new Response("asset")); }
          };
        });
      }
      if (actionsRemaining < 1) return new Response(null, { status: 429 });
      actionsRemaining--;
      return input.method === "GET"
        ? new Response("asset", { headers: { "content-type": "text/javascript; charset=utf-8" } })
        : new Response(null, { status: 204 });
    }) };
    const open = createCollaborativeAppLaunchUpstreamFactory({
      issuer: issuer as never, relay: relay as never, clientOrigin: "https://app.matrix-os.com", now: () => now,
    });
    const upstream = await open({ actorId, scopeId, organizationId, runtimeId: "runtime_owner",
      authorityGeneration: 1, appId: "team-tracker", catalogId: "50000000-0000-4000-8000-000000000001",
      buildId: "b".repeat(64), shareRevision: 1 });

    const slow = upstream.request("assets/slow.js", new AbortController().signal);
    await vi.waitFor(() => expect(releaseSlow).toBeTypeOf("function"));
    expect((await upstream.request("assets/fast.js", new AbortController().signal)).status).toBe(200);
    const third = upstream.request("assets/third.js", new AbortController().signal);
    await Promise.resolve();
    expect(ticketCount).toBe(1);
    releaseSlow!();
    expect((await slow).status).toBe(200);
    expect((await third).status).toBe(200);

    for (let index = 0; index < 5; index++) {
      const response = await upstream.request(`assets/${index}.js`, new AbortController().signal);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("asset");
    }
    const concurrent = await Promise.all(Array.from({ length: 4 }, (_, index) =>
      upstream.request(`assets/concurrent-${index}.js`, new AbortController().signal)));
    expect(concurrent.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    expect(ticketCount).toBeGreaterThan(1);
    expect(relay.forward.mock.calls.some(([input]) => input.path === `/api/collaboration/direct-sessions/${sessionId}/renew`)).toBe(true);
    const proofKeys = issuer.issue.mock.calls.map(([input]) => input.request.proofPublicKey);
    expect(new Set(proofKeys).size).toBe(1);
    await upstream.close();
    expect(relay.forward.mock.calls.at(-1)?.[0].method).toBe("DELETE");
  });
});
