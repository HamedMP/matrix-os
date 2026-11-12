// @vitest-environment jsdom
import React from "react";
import { createHash, webcrypto } from "node:crypto";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { CollaborationRelay } from "../../packages/platform/src/collaboration/relay.js";
import { createCollaborationDirectApi } from "../../packages/ui/src/collaboration/direct-api.js";
import { ProjectSharingButton } from "../../packages/ui/src/collaboration/ProjectSharingButton.js";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false; });
});

const platform = "https://app.matrix-os.com";
const runtimeId = "vps:11111111-1111-4111-8111-111111111111";
const logical = runtimeId.replace(":", "-");
const ownerId = "user_owner";
const organizationId = "org_matrix";
const scopeId = "10000000-0000-4000-8000-000000000367";
const base = `/api/collaboration/scopes/${scopeId}`;
const setup = `/api/collaboration/runtimes/${encodeURIComponent(runtimeId)}/scopes`;
const now = new Date("2026-10-22T12:00:00.000Z");
const scope = {
  id: scopeId, ownerId, organizationId, kind: "project", resourceId: "proj_fresh", membershipMode: "direct",
  lifecycle: "private", revision: "1", authEpoch: "1", authorityGeneration: "4", role: "owner",
  capabilities: { read: false, discuss: false, manageMembers: true, requestAi: false, observeTerminal: false, controlTerminal: false, stopTerminal: false },
};

/** Session responses are fixtures; route classification and the browser signer/facade are real. */
function harness() {
  const calls: string[] = [];
  const directory = vi.fn(async () => null);
  let live = true;
  const relay = new CollaborationRelay({
    resolveScopeHome: directory, resolveInvitationHome: async () => null,
    resolveSessionHome: async (id) => id === logical ? { runtimeId: logical, origin: "https://owner.test" } : null,
    resolveRuntimeHome: async (actor, id) => actor === ownerId && id === runtimeId ? { runtimeId: logical, origin: "https://owner.test" } : null,
    resolveOwnerRuntimeHome: async (actor, id) => actor === ownerId && id === logical ? { runtimeId: logical, origin: "https://owner.test" } : null,
    fetchImpl: (async (input, init) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      calls.push(`${method} ${path}`);
      if (path.endsWith("/owner-runtime/sessions")) {
        const proofPublicKey = JSON.parse(await new Response(init?.body).text()).proofPublicKey;
        return Response.json({ protocolVersion: 2, id: "20000000-0000-4000-8000-000000000367", actorId: ownerId,
          organizationId, runtimeId: logical, authorityGeneration: 4, purpose: "owner_runtime",
          proofKeyThumbprint: createHash("sha256").update(Buffer.from(proofPublicKey, "base64url")).digest("base64url"),
          issuedAt: now.toISOString(), expiresAt: new Date(+now + 300_000).toISOString(),
          evidenceExpiresAt: new Date(+now + 20_000).toISOString(), renewAfter: new Date(+now + 240_000).toISOString() }, { status: 201 });
      }
      expect(new Headers(init?.headers).get("x-matrix-collaboration-session")).toBeTruthy();
      if (path.endsWith("/scopes/preflight")) return Response.json({ eligible: true, resourceRevision: "1", confirmationToken: "p".repeat(64) });
      if (path === setup || path === base) return Response.json(scope);
      if (path.endsWith("/grants")) return Response.json(method === "GET" ? [] : {});
      if (path.endsWith("/project/inventory")) return Response.json({ scopeId, projectId: "proj_fresh", projectRevision: "1", scopeRevision: "2",
        ownedItems: [], externalReferences: [], blockers: [], membershipEffects: [], inventoryHash: "a".repeat(64), membershipHash: "b".repeat(64),
        inventoryToken: "t".repeat(64), expiresAt: new Date(+now + 60_000).toISOString() });
      return Response.json({ error: "Collaboration unavailable" }, { status: 404 });
    }) as typeof fetch,
  });
  const api = createCollaborationDirectApi({ platformBaseUrl: platform, clientOrigin: platform,
    subtle: webcrypto.subtle as SubtleCrypto, now: () => now,
    fetchImpl: (async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/collaboration/owner-runtime/connections") {
        calls.push(`POST ${url.pathname}`);
        if (!live) return Response.json({ error: "host_offline" }, { status: 503 });
        const proofPublicKey = JSON.parse(String(init?.body)).proofPublicKey;
        return Response.json({ signedTicket: { ticket: {
          protocolVersion: 2, ticketId: "30000000-0000-4000-8000-000000000367", nonce: "a".repeat(64), actorId: ownerId, organizationId,
          resource: { kind: "owner_runtime" }, purpose: "owner_runtime", runtime: { runtimeId: logical, authorityGeneration: 4 },
          proofKeyThumbprint: createHash("sha256").update(Buffer.from(proofPublicKey, "base64url")).digest("base64url"),
          maxActions: 32, issuedAt: now.toISOString(), expiresAt: new Date(+now + 30_000).toISOString(),
        }, keyId: "platform", signature: "a".repeat(86) }, endpoint: { origin: platform, protocolVersion: 2 } }, { status: 201 });
      }
      return relay.forward({ actorId: ownerId, method: init?.method ?? "GET", path: url.pathname, query: url.search.slice(1),
        headers: new Headers(init?.headers), body: typeof init?.body === "string" ? new TextEncoder().encode(init.body) : null });
    }) as typeof fetch,
  });
  return { api, calls, directory, offline() { live = false; }, recover() { live = true; }, close() { api.direct.close(); relay.close(); } };
}

function button(api: ReturnType<typeof harness>["api"]) {
  return <ProjectSharingButton api={api} runtimeId={runtimeId} organizationId={organizationId} organizationName="Matrix Main"
    projectId="proj_fresh" projectName="Fresh project" />;
}

describe("first-click sharing over the real direct client and relay classifier", () => {
  it("opens the dialog after preflight, private create/read, default grant and inventory without a directory route", async () => {
    const h = harness();
    const view = render(button(h.api));
    try {
      fireEvent.click(screen.getByRole("button", { name: "Share project" }));
      await screen.findByRole("heading", { name: "Share “Fresh project”" });
      expect(h.calls.slice(0, 8)).toEqual([
        "POST /api/collaboration/owner-runtime/connections", "POST /api/collaboration/owner-runtime/sessions",
        `POST ${setup}/preflight`, `POST ${setup}`, `GET ${base}`, `GET ${base}/grants`, `POST ${base}/grants`, `GET ${base}/project/inventory`,
      ]);
      expect(h.directory).toHaveBeenCalled();
      expect(h.calls.some(path => path.endsWith("/project/confirm"))).toBe(false);
      expect(scope.lifecycle).toBe("private");
    } finally { view.unmount(); h.close(); }
  });

  it("creates and publishes nothing while offline, then succeeds once control readiness has recovered", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const h = harness();
    h.offline();
    const view = render(button(h.api));
    try {
      fireEvent.click(screen.getByRole("button", { name: "Share project" }));
      await screen.findByText("Project sharing is unavailable. The project remains private and unchanged.");
      expect(h.calls).toEqual(["POST /api/collaboration/owner-runtime/connections"]);
      expect(screen.queryByRole("dialog")).toBeNull();
      h.recover();
      fireEvent.click(screen.getByRole("button", { name: "Share project" }));
      await screen.findByRole("heading", { name: "Share “Fresh project”" });
      expect(h.calls.filter(path => path === `POST ${setup}`)).toHaveLength(1);
      expect(h.calls.some(path => path.endsWith("/project/confirm"))).toBe(false);
    } finally { view.unmount(); h.close(); warn.mockRestore(); }
  });
});
