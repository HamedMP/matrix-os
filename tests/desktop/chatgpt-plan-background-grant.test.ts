import { expect, it, vi } from "vitest";
import { registerChatgptPlanIpc } from "../../desktop/src/main/ipc/chatgpt-plan";
import { createNativeChatgptPlanService } from "../../desktop/src/main/chatgpt-plan/service";
import { fixture, request, session } from "./chatgpt-plan-roundtrip-support";

function grantHandler(x: Awaited<ReturnType<typeof fixture>>) {
  const handlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>();
  registerChatgptPlanIpc({ handle: (name, handler) => handlers.set(name, handler) }, x.service, event => event === "main");
  return handlers.get("chatgpt-plan:set-grant")!;
}

it("authorizes background only through an explicit current-account IPC grant and signs the saved permission", async () => {
  // Removing IPC support, vault persistence, signed propagation, or background
  // admission must break this real native boundary (issuer HTTP is a fixture).
  const x = await fixture();
  try {
    await x.signedIn();
    const before = await x.service.status(session);
    expect(before.grant.background).toBe(false);
    const handlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>();
    registerChatgptPlanIpc({ handle: (name, handler) => handlers.set(name, handler) }, x.service, event => event === "main");
    const after = await handlers.get("chatgpt-plan:set-grant")!("main", {
      ...session, enabled: true, background: true,
      accountId: before.account!.id, baseRevision: before.grant.revision,
    }) as typeof before;
    expect(after.grant).toEqual({ enabled: true, background: true, revision: before.grant.revision + 1 });
    const saved = await x.vault.load("owner");
    expect(saved.grants.find(grant => grant.computerId === "computer")).toMatchObject(after.grant);
    expect(x.snapshots.at(-1)).toMatchObject({ accountId: before.account!.id, enabled: true, background: true, grantRevision: after.grant.revision });
    const run = request("00000000-0000-4000-8000-000000000030", before.account!.id, after.grant.revision);
    if (run.action !== "infer") throw new Error("Expected inference fixture");
    run.requestClass = "background";
    x.queue([run]);
    await vi.waitFor(() => expect(x.replies).toHaveLength(1));
    expect(x.replies[0]?.ok).toBe(true);
    expect(x.providerBodies).toHaveLength(1);
  } finally { await x.cleanup(); }
});

it.each([
  { name: "another account", patch: { accountId: "00000000-0000-4000-8000-000000000099" } },
  { name: "an old grant revision", patch: { baseRevision: 0 } },
  { name: "another Computer runtime", patch: { runtimeSlot: "other-computer" } },
  { name: "a stale native session", patch: { authGeneration: 0 } },
])("rejects background consent for $name without changing saved authority", async ({ patch }) => {
  const x = await fixture();
  try {
    await x.signedIn();
    const before = await x.service.status(session);
    const publications = x.snapshots.length;
    await expect(grantHandler(x)("main", {
      ...session, enabled: true, background: true,
      accountId: before.account!.id, baseRevision: before.grant.revision, ...patch,
    })).rejects.toThrow();
    expect((await x.service.status(session)).grant).toEqual(before.grant);
    expect((await x.vault.load("owner")).grants.find(grant => grant.computerId === "computer")).toMatchObject(before.grant);
    expect(x.snapshots).toHaveLength(publications);
  } finally { await x.cleanup(); }
});

it("explicit reconnect returns a previously opted-in account to interactive-only permission", async () => {
  const x = await fixture();
  try {
    await x.signedIn();
    const before = await x.service.status(session);
    const optedIn = await grantHandler(x)("main", {
      ...session, enabled: true, background: true,
      accountId: before.account!.id, baseRevision: before.grant.revision,
    }) as typeof before;
    expect(optedIn.grant.background).toBe(true);
    const after = await x.service.connect({ ...session, purpose: "personal_local" });
    expect(after.grant).toEqual({ enabled: true, background: false, revision: optedIn.grant.revision + 1 });
    expect(x.snapshots.at(-1)).toMatchObject({ background: false, grantRevision: after.grant.revision });
    expect(x.providerBodies).toHaveLength(0);
  } finally { await x.cleanup(); }
});

it("revocation wins over a late opt-in waiting for peer shutdown", async () => {
  const x = await fixture();
  let release = () => {};
  try {
    await x.signedIn();
    const before = await x.service.status(session);
    release = x.holdDisconnect();
    const pending = x.service.setGrant({ ...session, enabled: true, background: true,
      accountId: before.account!.id, baseRevision: before.grant.revision });
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(x.fetchFn.mock.calls.some(call => String(call[0]).endsWith("/device/disconnect"))).toBe(true));
    const revoked = await x.service.setGrant({ ...session, enabled: true, background: false,
      accountId: before.account!.id, baseRevision: before.grant.revision });
    release();
    await rejected;
    expect(revoked.grant.background).toBe(false);
    expect((await x.vault.load("owner")).grants.find(grant => grant.computerId === "computer")).toMatchObject(revoked.grant);
    expect(x.snapshots.every(snapshot => !(snapshot as { background: boolean }).background)).toBe(true);
  } finally { release(); await x.cleanup(); }
});

it("revokes an in-flight background request and rejects its old revision without disabling interactive use", async () => {
  const x = await fixture();
  let release = () => {};
  try {
    await x.signedIn();
    const before = await x.service.status(session);
    const optedIn = await x.service.setGrant({ ...session, enabled: true, background: true,
      accountId: before.account!.id, baseRevision: before.grant.revision });
    release = x.holdResponse();
    const active = request("00000000-0000-4000-8000-000000000031", before.account!.id, optedIn.grant.revision);
    if (active.action !== "infer") throw new Error("Expected inference fixture");
    active.requestClass = "background";
    x.queue([active]);
    await vi.waitFor(() => expect(x.providerBodies).toHaveLength(1));
    const revoked = await x.service.setGrant({ ...session, enabled: true, background: false,
      accountId: before.account!.id, baseRevision: optedIn.grant.revision });
    expect(x.responseAborted).toBe(true);
    expect(revoked.grant).toEqual({ enabled: true, background: false, revision: optedIn.grant.revision + 1 });
    expect(x.snapshots.at(-1)).toMatchObject({ background: false, grantRevision: revoked.grant.revision });
    release();
    const stale = request("00000000-0000-4000-8000-000000000032", before.account!.id, optedIn.grant.revision);
    if (stale.action !== "infer") throw new Error("Expected inference fixture");
    stale.requestClass = "background";
    x.queue([stale]);
    await vi.waitFor(() => expect(x.replies.find(reply => reply.id === stale.id)?.ok).toBe(false));
    expect(x.providerBodies).toHaveLength(1);
    const interactive = request("00000000-0000-4000-8000-000000000033", before.account!.id, revoked.grant.revision);
    x.queue([interactive]);
    await vi.waitFor(() => expect(x.replies.find(reply => reply.id === interactive.id)?.ok).toBe(true));
    expect(x.providerBodies).toHaveLength(2);
  } finally { release(); await x.cleanup(); }
});

it("restores a real saved background grant without another OAuth or implicit permission write", async () => {
  const x = await fixture();
  let restored: ReturnType<typeof createNativeChatgptPlanService> | undefined;
  try {
    await x.signedIn();
    const before = await x.service.status(session);
    const optedIn = await x.service.setGrant({ ...session, enabled: true, background: true,
      accountId: before.account!.id, baseRevision: before.grant.revision });
    await x.service.dispose();
    restored = createNativeChatgptPlanService({ vault: x.vault, fetchFn: x.fetchFn,
      auth: { getStatus: () => x.authState, getToken: () => "fixture-matrix-bearer", getGatewayOrigin: () => "https://matrix.test" },
      openBrowser: async () => { throw new Error("Unexpected OAuth during restoration"); } });
    const after = await restored.status(session);
    expect(after.grant).toEqual(optedIn.grant);
    expect(after.bridgeConnected).toBe(true);
    expect(x.snapshots.at(-1)).toMatchObject({ background: true, grantRevision: optedIn.grant.revision });
  } finally { await restored?.dispose(); await x.cleanup(); }
});

it("never publishes an opt-in whose vault write failed", async () => {
  const x = await fixture();
  try {
    await x.signedIn();
    const before = await x.service.status(session);
    vi.spyOn(x.vault, "save").mockRejectedValueOnce(new Error("Fixture disk failure"));
    await expect(x.service.setGrant({ ...session, enabled: true, background: true,
      accountId: before.account!.id, baseRevision: before.grant.revision })).rejects.toThrow("Fixture disk failure");
    expect((await x.service.status(session)).grant).toEqual(before.grant);
    expect(x.snapshots.every(snapshot => !(snapshot as { background: boolean }).background)).toBe(true);
  } finally { await x.cleanup(); }
});

it("keeps background stopped in memory when persistence cannot confirm a revocation", async () => {
  const x = await fixture();
  try {
    await x.signedIn();
    const before = await x.service.status(session);
    const optedIn = await x.service.setGrant({ ...session, enabled: true, background: true,
      accountId: before.account!.id, baseRevision: before.grant.revision });
    vi.spyOn(x.vault, "save").mockRejectedValueOnce(new Error("Fixture disk failure"));
    await expect(x.service.setGrant({ ...session, enabled: true, background: false,
      accountId: before.account!.id, baseRevision: optedIn.grant.revision })).rejects.toThrow("Fixture disk failure");
    expect((await x.service.status(session)).grant.background).toBe(false);
    await x.service.refreshModels(session);
    expect(x.snapshots.at(-1)).toMatchObject({ background: false });
    // The failure stays explicit: this is not a claim that a failed write was durable.
    expect((await x.vault.load("owner")).grants.find(grant => grant.computerId === "computer")?.background).toBe(true);
    const observed = await x.service.status(session);
    const repaired = await x.service.setGrant({ ...session, enabled: true, background: false,
      accountId: before.account!.id, baseRevision: observed.grant.revision });
    expect(repaired.grant.background).toBe(false);
    expect(repaired.grant.revision).toBe(observed.grant.revision + 1);
    expect((await x.vault.load("owner")).grants.find(grant => grant.computerId === "computer")).toMatchObject(repaired.grant);
  } finally { await x.cleanup(); }
});

it.each(["Computer", "owner", "session"] as const)("retains an unconfirmed downgrade across a %s roundtrip until it is saved", async kind => {
  const x = await fixture();
  try {
    await x.signedIn();
    const before = await x.service.status(session);
    const optedIn = await x.service.setGrant({ ...session, enabled: true, background: true,
      accountId: before.account!.id, baseRevision: before.grant.revision });
    vi.spyOn(x.vault, "save").mockRejectedValueOnce(new Error("Fixture disk failure"));
    await expect(x.service.setGrant({ ...session, enabled: true, background: false,
      accountId: before.account!.id, baseRevision: optedIn.grant.revision })).rejects.toThrow("Fixture disk failure");
    expect((await x.vault.load("owner")).grants.find(g => g.computerId === "computer")?.background).toBe(true);
    x.authState.authGeneration = 2;
    if (kind === "Computer") { x.authState.runtimeSlot = "other"; x.authState.handle = "other-computer"; }
    if (kind === "owner") x.authState.userId = "other-owner";
    x.service.cancelAll();
    await x.service.status({ runtimeSlot: x.authState.runtimeSlot, authGeneration: 2 });
    Object.assign(x.authState, { ...session, authGeneration: 3, userId: "owner", handle: "computer" });
    x.service.cancelAll();
    const returned = await x.service.status({ ...session, authGeneration: 3 });
    expect(returned.grant).toEqual({ enabled: true, background: false, revision: optedIn.grant.revision + 1 });
    expect(returned).toHaveProperty("grantSaveUnconfirmed", true);
    expect(x.snapshots.at(-1)).toMatchObject({ background: false, grantRevision: returned.grant.revision });
    const stale = request("00000000-0000-4000-8000-000000000034", before.account!.id, optedIn.grant.revision);
    if (stale.action !== "infer") throw new Error("Expected inference fixture");
    stale.requestClass = "background";
    x.queue([stale]);
    await vi.waitFor(() => expect(x.replies.find(reply => reply.id === stale.id)?.ok).toBe(false));
    expect(x.providerBodies).toHaveLength(0);
    const repaired = await x.service.setGrant({ ...session, authGeneration: 3, enabled: true, background: false,
      accountId: before.account!.id, baseRevision: returned.grant.revision });
    expect(repaired.grant.background).toBe(false);
    expect(repaired).not.toHaveProperty("grantSaveUnconfirmed");
    expect((await x.vault.load("owner")).grants.find(g => g.computerId === "computer")).toMatchObject(repaired.grant);
  } finally { await x.cleanup(); }
});

it("does not let an earlier token save erase a newer disconnect fence when disconnect persistence fails", async () => {
  const x = await fixture();
  let release = () => {};
  let clock: { mockRestore(): void } | undefined;
  try {
    await x.signedIn();
    const before = await x.service.status(session);
    await x.service.setGrant({ ...session, enabled: true, background: true,
      accountId: before.account!.id, baseRevision: before.grant.revision });
    let started = () => {};
    const writing = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const originalSave = x.vault.save.bind(x.vault);
    const save = vi.spyOn(x.vault, "save").mockImplementationOnce(async (owner, next) => {
      started(); await gate; await originalSave(owner, next);
    });
    const readAt = Date.now();
    const heldClock = vi.spyOn(Date, "now").mockReturnValue(readAt + 301_000);
    clock = heldClock;
    const refresh = x.service.refreshModels(session);
    const refreshed = Promise.allSettled([refresh]);
    await writing;
    heldClock.mockReturnValue(readAt);
    const disconnect = x.service.disconnect(session);
    const failed = expect(disconnect).rejects.toThrow("Fixture disconnect disk failure");
    await vi.waitFor(async () => expect((await x.service.status(session)).grant.enabled).toBe(false));
    save.mockRejectedValueOnce(new Error("Fixture disconnect disk failure"));
    release();
    await Promise.all([refreshed, failed]);
    const returned = await x.service.status(session);
    expect(returned.state).toBe("disconnected");
    expect(returned.grant.enabled).toBe(false);
    expect(returned.bridgeConnected).toBe(false);
    expect(returned).toHaveProperty("grantSaveUnconfirmed", true);
    expect(x.providerBodies).toHaveLength(0);
  } finally { release(); clock?.mockRestore(); await x.cleanup(); }
});

it("rejects new owners at the unconfirmed-save bound without evicting a downgrade and releases capacity after repair", async () => {
  const x = await fixture();
  const save = vi.spyOn(x.vault, "save");
  try {
    for (let i = 0; i < 8; i++) {
      x.authState.userId = `owner-${i}`;
      x.service.cancelAll();
      await x.signedIn();
      const before = await x.service.status(session);
      const optedIn = await x.service.setGrant({ ...session, enabled: true, background: true,
        accountId: before.account!.id, baseRevision: before.grant.revision });
      save.mockRejectedValueOnce(new Error("Fixture disk failure"));
      await expect(x.service.setGrant({ ...session, enabled: true, background: false,
        accountId: before.account!.id, baseRevision: optedIn.grant.revision })).rejects.toThrow();
    }
    x.authState.userId = "new-owner";
    x.service.cancelAll();
    await expect(x.service.status(session)).rejects.toThrow("grant recovery required");
    x.authState.userId = "owner-0";
    x.service.cancelAll();
    const original = await x.service.status(session);
    expect(original.grant.background).toBe(false);
    expect(original).toHaveProperty("grantSaveUnconfirmed", true);
    await x.service.setGrant({ ...session, enabled: true, background: false,
      accountId: original.account!.id, baseRevision: original.grant.revision });
    x.authState.userId = "new-owner";
    x.service.cancelAll();
    expect((await x.service.status(session)).state).toBe("disconnected");
    expect(x.providerBodies).toHaveLength(0);
  } finally { await x.cleanup(); }
});

it("rejects even complete opt-in intent from an embedded frame", async () => {
  const x = await fixture();
  try {
    await x.signedIn();
    const before = await x.service.status(session);
    await expect(grantHandler(x)("embed", { ...session, enabled: true, background: true,
      accountId: before.account!.id, baseRevision: before.grant.revision })).rejects.toThrow("invalid request");
    expect((await x.service.status(session)).grant).toEqual(before.grant);
    expect(x.snapshots.every(snapshot => !(snapshot as { background: boolean }).background)).toBe(true);
  } finally { await x.cleanup(); }
});

it("cannot save an old owner's opt-in after the native identity changes during shutdown", async () => {
  const x = await fixture();
  let release = () => {};
  try {
    await x.signedIn();
    const before = await x.service.status(session);
    release = x.holdDisconnect();
    const pending = x.service.setGrant({ ...session, enabled: true, background: true,
      accountId: before.account!.id, baseRevision: before.grant.revision });
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(x.fetchFn.mock.calls.some(call => String(call[0]).endsWith("/device/disconnect"))).toBe(true));
    x.authState.userId = "other-owner";
    x.authState.authGeneration = 2;
    x.service.cancelAll();
    const replacement = await x.service.status({ ...session, authGeneration: 2 });
    expect(replacement.state).toBe("disconnected");
    release();
    await rejected;
    expect((await x.vault.load("owner")).grants.find(grant => grant.computerId === "computer")).toMatchObject(before.grant);
    expect((await x.service.status({ ...session, authGeneration: 2 })).grant.background).toBe(false);
  } finally { release(); await x.cleanup(); }
});

it("can durably revoke background when the provider catalog is temporarily unavailable", async () => {
  const x = await fixture();
  try {
    await x.signedIn();
    const before = await x.service.status(session);
    const optedIn = await x.service.setGrant({ ...session, enabled: true, background: true,
      accountId: before.account!.id, baseRevision: before.grant.revision });
    x.catalogStatus(503);
    await expect(x.service.refreshModels(session)).rejects.toThrow();
    const revoked = await x.service.setGrant({ ...session, enabled: true, background: false,
      accountId: before.account!.id, baseRevision: optedIn.grant.revision });
    expect(revoked.grant.background).toBe(false);
    expect((await x.vault.load("owner")).grants.find(grant => grant.computerId === "computer")?.background).toBe(false);
    expect(x.providerBodies).toHaveLength(0);
  } finally { await x.cleanup(); }
});
