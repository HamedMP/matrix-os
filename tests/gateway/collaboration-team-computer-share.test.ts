import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { TeamComputerShareService, TeamComputerShareError } from "../../packages/gateway/src/collaboration/team-computer-share.js";
import { readTeamTerminalLabel } from "../../packages/gateway/src/collaboration/team-terminal-labels.js";
import { createCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";

const ownerId = "user_owner";
const organizationId = "org_team";
const incarnation = `terminal-${"a".repeat(32)}`;
const tab = (n: number) => `tws_${"3".repeat(32)}:tt_${String(n).padStart(32, "0")}`;
const scopeFor = (terminalId: string) => `10000000-0000-4000-8000-${terminalId.slice(-12)}`;

describe("whole-computer sharing (spec 2710 layer 6)", () => {
  let fixture: CollaborationTestDatabase;
  let terminals: string[];
  let shared: Map<string, string>;
  let grants: Map<string, Array<{ grantId: string; audience: { kind: "organization" } | { kind: "member"; actorId: string }; preset: "viewer" | "contributor"; state: string; grantRevision: number }>>;
  let controls: Map<string, boolean>;
  let committed: string[];

  const service = (overrides: Partial<ConstructorParameters<typeof TeamComputerShareService>[0]> = {}) => new TeamComputerShareService({
    db: fixture.db,
    ownerId,
    listTerminals: async () => terminals,
    openTerminal: async () => { const created = tab(terminals.length + 1); terminals.push(created); return created; },
    terminals: {
      preflight: async ({ terminalId }) => shared.has(terminalId)
        ? { eligible: true, resourceRevision: 1, confirmationToken: "t".repeat(64), existingScopeId: shared.get(terminalId)! }
        : { eligible: true, resourceRevision: 1, confirmationToken: "t".repeat(64) },
      shareTerminal: async ({ terminalId }) => {
        const id = scopeFor(terminalId);
        shared.set(terminalId, id);
        await fixture.db.insertInto("collaboration_scopes").values({
          id, owner_type: "personal", owner_id: ownerId, organization_id: organizationId, kind: "terminal", resource_id: terminalId,
          parent_scope_id: null, membership_mode: "direct", lifecycle: "shared", revision: 1, authority_runtime_id: "runtime_owner",
        } as never).execute();
        return { id };
      },
      get: async () => ({ incarnation, status: "active" }),
      setContributorControl: async ({ scopeId, contributorControl }) => { controls.set(scopeId, contributorControl); },
    },
    grants: {
      list: async (scopeId) => grants.get(scopeId) ?? [],
      create: async ({ scopeId, audience, preset }) => {
        grants.set(scopeId, [...(grants.get(scopeId) ?? []), { grantId: `g_${scopeId}_${(grants.get(scopeId) ?? []).length}`, audience, preset, state: "pending", grantRevision: 1 }]);
      },
      patch: async ({ scopeId, grantId, preset }) => {
        grants.set(scopeId, (grants.get(scopeId) ?? []).map((grant) => grant.grantId === grantId ? { ...grant, preset, grantRevision: grant.grantRevision + 1 } : grant));
      },
      revoke: async ({ scopeId, grantId }) => {
        grants.set(scopeId, (grants.get(scopeId) ?? []).map((grant) => grant.grantId === grantId ? { ...grant, state: "revoked" } : grant));
      },
    },
    scopeRevision: async () => 1,
    committed: async (scopeId) => { committed.push(scopeId); },
    ...overrides,
  });

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    terminals = [tab(1), tab(2)];
    shared = new Map();
    grants = new Map();
    controls = new Map();
    committed = [];
  });
  afterEach(async () => { await fixture.destroy(); });

  it("shares every tab with the same people, names the computer and lets editors type", async () => {
    const computers = service();
    await expect(computers.share({ organizationId, computerLabel: "team-dev-1", grants: [
      { audience: { kind: "organization" }, preset: "contributor" },
      { audience: { kind: "member", actorId: "user_sam" }, preset: "viewer" },
    ] })).resolves.toBe(2);
    for (const terminalId of terminals) {
      const scopeId = shared.get(terminalId)!;
      expect(grants.get(scopeId)!.map((grant) => grant.preset)).toEqual(["contributor", "viewer"]);
      expect(controls.get(scopeId)).toBe(true);
      expect(await computers.isComputerScope(scopeId)).toBe(true);
      expect(await readTeamTerminalLabel(fixture.db, scopeId)).toBe("team-dev-1");
    }
    expect(committed).toHaveLength(2);
  });

  it("shares a tab opened later on the next pass, and changes roles without duplicating grants", async () => {
    const computers = service();
    await computers.share({ organizationId, computerLabel: "team-dev-1", grants: [{ audience: { kind: "organization" }, preset: "contributor" }] });
    terminals.push(tab(3));
    await computers.sync();
    expect(grants.get(shared.get(tab(3))!)).toHaveLength(1);
    await computers.share({ organizationId, computerLabel: "team-dev-1", grants: [{ audience: { kind: "organization" }, preset: "viewer" }] });
    for (const terminalId of terminals) {
      expect(grants.get(shared.get(terminalId)!)!.map((grant) => grant.preset)).toEqual(["viewer"]);
      expect(controls.get(shared.get(terminalId)!)).toBe(false);
    }
  });

  it("stops sharing: every grant on the computer's tabs ends and nothing new is shared", async () => {
    const computers = service();
    await computers.share({ organizationId, computerLabel: "team-dev-1", grants: [{ audience: { kind: "organization" }, preset: "contributor" }] });
    await computers.stop();
    for (const terminalId of terminals) {
      const scopeId = shared.get(terminalId)!;
      expect(grants.get(scopeId)!.every((grant) => grant.state === "revoked")).toBe(true);
      expect(await computers.isComputerScope(scopeId)).toBe(false);
    }
    terminals.push(tab(4));
    await expect(computers.sync()).resolves.toBe(0);
    expect(shared.has(tab(4))).toBe(false);
    expect(await computers.policy()).toBeNull();
  });

  it("opens a new shared tab for an editor, at most ten a minute", async () => {
    const computers = service();
    await computers.share({ organizationId, computerLabel: "team-dev-1", grants: [{ audience: { kind: "organization" }, preset: "contributor" }] });
    const scopeId = await computers.openTab("user_yuhan");
    expect(scopeId).toBe(shared.get(tab(3)));
    for (let index = 0; index < 9; index += 1) await computers.openTab("user_yuhan");
    await expect(computers.openTab("user_yuhan")).rejects.toBeInstanceOf(TeamComputerShareError);
  });

  it("lets a stop wait for a running pass, so the pass cannot re-grant after it (Greptile on #3689)", async () => {
    const computers = service();
    await computers.share({ organizationId, computerLabel: "team-dev-1", grants: [{ audience: { kind: "organization" }, preset: "contributor" }] });
    terminals.push(tab(5));
    const pass = computers.sync();
    const stopped = computers.stop();
    await Promise.all([pass, stopped]);
    for (const terminalId of terminals) {
      const scopeId = shared.get(terminalId);
      if (scopeId) expect(grants.get(scopeId)!.every((grant) => grant.state === "revoked")).toBe(true);
    }
  });

  it("keeps every tab's access exactly the policy's, ending a grant the policy no longer names (Greptile on #3689)", async () => {
    const computers = service();
    await computers.share({ organizationId, computerLabel: "team-dev-1", grants: [
      { audience: { kind: "organization" }, preset: "viewer" },
      { audience: { kind: "member", actorId: "user_sam" }, preset: "contributor" },
    ] });
    await computers.share({ organizationId, computerLabel: "team-dev-1", grants: [{ audience: { kind: "organization" }, preset: "viewer" }] });
    for (const terminalId of terminals) {
      const live = grants.get(shared.get(terminalId)!)!.filter((grant) => grant.state !== "revoked");
      expect(live.map((grant) => grant.audience.kind)).toEqual(["organization"]);
    }
  });

  it("shares a new tab directly even on a computer with more than 64 tabs (Greptile on #3689)", async () => {
    terminals = Array.from({ length: 70 }, (_, index) => tab(index + 1));
    const computers = service();
    await computers.share({ organizationId, computerLabel: "team-dev-1", grants: [{ audience: { kind: "organization" }, preset: "contributor" }] });
    expect(terminals.every((terminalId) => shared.has(terminalId))).toBe(true);
    const scopeId = await computers.openTab("user_yuhan");
    expect(scopeId).toBe(shared.get(tab(71)));
  });

  it("lets only Editors the policy names open tabs (Greptile on #3689)", async () => {
    const computers = service();
    await computers.share({ organizationId, computerLabel: "team-dev-1", grants: [{ audience: { kind: "member", actorId: "user_sam" }, preset: "contributor" }] });
    await expect(computers.openTab("user_yuhan")).rejects.toMatchObject({ code: "forbidden" });
    await expect(computers.openTab("user_sam")).resolves.toEqual(expect.any(String));
  });

  it("keeps a failed stop recoverable and finishes it on the next stop (Greptile on #3689)", async () => {
    let failRevoke = true;
    const computers = service();
    await computers.share({ organizationId, computerLabel: "team-dev-1", grants: [{ audience: { kind: "organization" }, preset: "contributor" }] });
    const deps = (computers as unknown as { deps: { grants: { revoke: (input: { scopeId: string; grantId: string }) => Promise<unknown> } } }).deps;
    const revoke = deps.grants.revoke;
    deps.grants.revoke = async (input) => { if (failRevoke) throw new Error("revoke failed"); return revoke(input as never); };
    await expect(computers.stop()).rejects.toThrow();
    expect(await computers.stopping()).toBe(true);
    expect(await computers.policy()).toBeNull();
    await expect(computers.sync()).resolves.toBe(0);
    failRevoke = false;
    await computers.stop();
    expect(await computers.stopping()).toBe(false);
    for (const terminalId of terminals) expect(grants.get(shared.get(terminalId)!)!.every((grant) => grant.state === "revoked")).toBe(true);
  });

  it("refuses to open a tab on a computer that is not shared", async () => {
    await expect(service().openTab("user_yuhan")).rejects.toMatchObject({ code: "not_found" });
    expect(terminals).toHaveLength(2);
  });

  it("keeps sharing the other tabs when one tab cannot be shared", async () => {
    const failing = vi.fn(async () => { throw new Error("tab ended"); });
    const computers = service();
    const base = (computers as unknown as { deps: { terminals: Record<string, unknown> } }).deps.terminals;
    const original = base.preflight as (input: { terminalId: string }) => Promise<unknown>;
    base.preflight = (input: { terminalId: string }) => (input.terminalId === tab(1) ? failing() : original(input));
    await expect(computers.share({ organizationId, computerLabel: "team-dev-1", grants: [{ audience: { kind: "organization" }, preset: "viewer" }] })).resolves.toBe(1);
    expect(shared.has(tab(2))).toBe(true);
  });
});
