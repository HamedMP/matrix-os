import { describe, expect, it, vi } from "vitest";
import {
  prepareTeamTerminal,
  setTeamInputMode,
  stopSharingTeamTerminal,
  syncEditorTyping,
  TeamShareError,
} from "@desktop/renderer/src/features/terminal-window/share/team-share";

const scopeId = "10000000-0000-4000-8000-000000000001";
const runtimeId = "vps:11111111-1111-4111-8111-111111111111";
const terminalId = `tws_${"3".repeat(32)}:tt_${"4".repeat(32)}`;
const incarnation = `terminal-${"a".repeat(32)}`;

function scope(revision = "3") {
  return {
    id: scopeId, ownerId: "user_owner", organizationId: "org_team", kind: "terminal", resourceId: terminalId,
    lifecycle: "shared", membershipMode: "direct", revision, role: "owner", authEpoch: "1",
    authorityGeneration: "1", capabilities: { read: true, discuss: true, manageMembers: true, requestAi: false },
  };
}

function grant(id: string, preset: "viewer" | "contributor", state = "active") {
  return {
    id, scopeId, organizationId: "org_team", audience: { kind: "organization" }, preset, state,
    policyVersion: "preset-v1", revision: "2", createdAt: "2026-11-24T10:00:00.000Z", updatedAt: "2026-11-24T10:00:00.000Z",
  };
}

function fakeApi(overrides: Partial<Record<"get" | "post" | "put" | "patch" | "delete", (path: string, body?: unknown) => unknown>> = {}) {
  return {
    get: vi.fn(async (path: string) => overrides.get ? overrides.get(path) : scope()),
    post: vi.fn(async (path: string, body?: unknown) => overrides.post?.(path, body)),
    put: vi.fn(async (path: string, body?: unknown) => overrides.put?.(path, body) ?? {}),
    patch: vi.fn(async (path: string, body?: unknown) => overrides.patch?.(path, body) ?? {}),
    delete: vi.fn(async (path: string, body?: unknown) => overrides.delete?.(path, body) ?? {}),
  };
}

describe("team terminal owner flow (spec 2710 J1, J5, J6)", () => {
  it("shares a running tab once and names the computer", async () => {
    const api = fakeApi({
      post: (path) => path.endsWith("/preflight")
        ? { eligible: true, resourceRevision: "4", confirmationToken: "c".repeat(64) }
        : scope(),
    });
    const shared = await prepareTeamTerminal(api, { runtimeId, organizationId: "org_team", terminalId, computerLabel: "  team-dev-1 " });
    expect(shared.id).toBe(scopeId);
    expect(api.post).toHaveBeenNthCalledWith(1, `/api/collaboration/runtimes/${encodeURIComponent(runtimeId)}/scopes/preflight`,
      { kind: "terminal", resourceId: terminalId, organizationId: "org_team" });
    expect(api.post).toHaveBeenNthCalledWith(2, `/api/collaboration/runtimes/${encodeURIComponent(runtimeId)}/scopes`,
      expect.objectContaining({ kind: "terminal", expectedRevision: "4", confirmationToken: "c".repeat(64) }));
    expect(api.put).toHaveBeenCalledWith(`/api/collaboration/scopes/${scopeId}/terminal/team/label`, { computerLabel: "team-dev-1" });
  });

  it("reuses an existing share instead of creating another", async () => {
    const api = fakeApi({ post: () => ({ eligible: true, resourceRevision: "4", confirmationToken: "c".repeat(64), existingScopeId: scopeId, existingLifecycle: "shared" }) });
    await prepareTeamTerminal(api, { runtimeId, organizationId: "org_team", terminalId, computerLabel: "MacBook" });
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it("reports a tab that cannot be shared", async () => {
    const api = fakeApi({ post: () => ({ eligible: false, reason: "unavailable", resourceRevision: "0" }) });
    await expect(prepareTeamTerminal(api, { runtimeId, organizationId: "org_team", terminalId, computerLabel: "MacBook" }))
      .rejects.toBeInstanceOf(TeamShareError);
  });

  it("lets editors type only while an editor grant exists", async () => {
    const withEditor = fakeApi({ get: () => [grant("20000000-0000-4000-8000-000000000001", "contributor", "pending")] });
    await expect(syncEditorTyping(withEditor, scopeId)).resolves.toBe(true);
    expect(withEditor.patch).toHaveBeenCalledWith(`/api/collaboration/scopes/${scopeId}/terminal`, { contributorControl: true });
    const viewersOnly = fakeApi({ get: () => [grant("20000000-0000-4000-8000-000000000002", "viewer"), grant("20000000-0000-4000-8000-000000000003", "contributor", "revoked")] });
    await expect(syncEditorTyping(viewersOnly, scopeId)).resolves.toBe(false);
    expect(viewersOnly.patch).toHaveBeenCalledWith(`/api/collaboration/scopes/${scopeId}/terminal`, { contributorControl: false });
  });

  it("stops sharing by revoking every live grant at the current revision, then withdraws typing", async () => {
    let revision = 3;
    const revoked = new Set<string>();
    const api = fakeApi({
      get: (path) => path.endsWith("/grants")
        ? [grant("20000000-0000-4000-8000-000000000001", "contributor"), grant("20000000-0000-4000-8000-000000000002", "viewer"), grant("20000000-0000-4000-8000-000000000004", "viewer", "revoked")]
          .map((entry) => (revoked.has(entry.id) ? { ...entry, state: "revoked" } : entry))
        : scope(String(revision)),
      delete: (path) => { revision += 1; revoked.add(path.split("/").at(-1)!); return {}; },
    });
    await stopSharingTeamTerminal(api, scopeId);
    expect(api.delete).toHaveBeenCalledTimes(2);
    expect(api.delete).toHaveBeenNthCalledWith(1, `/api/collaboration/scopes/${scopeId}/grants/20000000-0000-4000-8000-000000000001`,
      expect.objectContaining({ expectedRevision: "3", expectedMemberRevision: "2" }));
    expect(api.delete).toHaveBeenNthCalledWith(2, expect.any(String), expect.objectContaining({ expectedRevision: "4" }));
    expect(api.patch).toHaveBeenLastCalledWith(`/api/collaboration/scopes/${scopeId}/terminal`, { contributorControl: false });
  });

  it("ends a grant that committed while stopping, and refuses to report a share that keeps access (Greptile on #3679)", async () => {
    let listed = 0;
    const late = grant("20000000-0000-4000-8000-000000000009", "viewer");
    const api = fakeApi({ get: (path) => {
      if (!path.endsWith("/grants")) return scope();
      listed += 1;
      return listed === 1 ? [] : listed === 2 ? [late] : [];
    } });
    // The first list was empty; a grant landed before the second.
    await stopSharingTeamTerminal(api, scopeId);
    expect(api.delete).toHaveBeenCalledWith(expect.stringContaining(late.id), expect.anything());
    const stuck = fakeApi({ get: (path) => path.endsWith("/grants") ? [late] : scope() });
    await expect(stopSharingTeamTerminal(stuck, scopeId)).rejects.toBeInstanceOf(TeamShareError);
  });

  it("takes control on the exact terminal incarnation", async () => {
    const api = fakeApi({ get: () => ({
      id: terminalId, scopeId, incarnation, executionGeneration: "4", status: "active",
      createdBy: { actorId: "user_owner", displayName: "Nima" }, createdAt: "2026-11-24T10:00:00.000Z",
    }) });
    await setTeamInputMode(api, scopeId, "owner");
    expect(api.post).toHaveBeenCalledWith(`/api/collaboration/scopes/${scopeId}/terminal/actions`,
      expect.objectContaining({ type: "input_mode", incarnation, mode: "owner" }));
  });
});

describe("whole-computer sharing from the owner's dialog (spec 2710 layer 6)", () => {
  it("shares the computer with exactly this terminal's live grants, and stops it", async () => {
    const { shareComputer, stopSharingComputer } = await import("@desktop/renderer/src/features/terminal-window/share/team-share");
    const api = fakeApi({ get: (path) => path.endsWith("/grants")
      ? [grant("20000000-0000-4000-8000-000000000001", "contributor"), grant("20000000-0000-4000-8000-000000000002", "viewer", "revoked")]
      : scope() });
    await shareComputer(api, scopeId);
    expect(api.put).toHaveBeenCalledWith(`/api/collaboration/scopes/${scopeId}/terminal/team/computer`,
      { grants: [{ audience: { kind: "organization" }, preset: "contributor" }] });
    await stopSharingComputer(api, scopeId);
    expect(api.delete).toHaveBeenCalledWith(`/api/collaboration/scopes/${scopeId}/terminal/team/computer`, expect.objectContaining({ expectedRevision: "3" }));
  });

  it("refuses to share a computer before anyone has access to this terminal", async () => {
    const { shareComputer } = await import("@desktop/renderer/src/features/terminal-window/share/team-share");
    const api = fakeApi({ get: (path) => path.endsWith("/grants") ? [] : scope() });
    await expect(shareComputer(api, scopeId)).rejects.toBeInstanceOf(TeamShareError);
    expect(api.put).not.toHaveBeenCalled();
  });
});
