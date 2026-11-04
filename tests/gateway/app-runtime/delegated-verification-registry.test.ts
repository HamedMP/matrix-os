import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DelegatedVerificationRegistry, type VerificationAuthority } from "../../../packages/gateway/src/app-runtime/delegated-verification-registry.js";

const binding = { ownerId: "user_owner", runtimeId: "runtime_primary", runId: "run_one", slug: "notes" };
const now = 1_800_000_000_000;
let authority: VerificationAuthority;
let registry: DelegatedVerificationRegistry;
const audit = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  authority = {
    ...binding, active: true, origin: "owner-built", approvalId: "approval_one",
    approvalExpiresAt: now + 30_000, fingerprint: "sha256:trusted-build",
  };
  audit.mockClear();
  registry = new DelegatedVerificationRegistry({
    ownerId: binding.ownerId, runtimeId: binding.runtimeId,
    ttlMs: 30_000, maxEntries: 2,
    readAuthority: async () => ({ ...authority }), audit,
  });
});

afterEach(() => { registry.close(); vi.useRealTimers(); });

async function issue() {
  const grant = await registry.issue(binding.ownerId, binding);
  expect(grant).not.toBeNull();
  return grant!;
}

describe("delegated verification registry", () => {
  it("redeems to an independent session credential with the original deadline", async () => {
    const grant = await issue();
    const session = await registry.redeem(grant.capability, binding);
    expect(session).toMatchObject({ binding, expiresAt: grant.expiresAt });
    expect(session!.credential).not.toBe(grant.capability);
    expect(await registry.authorize(session!.credential, binding)).toEqual(binding);
  });

  it.each(["ownerId", "runtimeId", "runId", "slug"] as const)("denies a wrong %s at issuance and redemption", async (field) => {
    const wrong = { ...binding, [field]: "other" };
    expect(await registry.issue(binding.ownerId, wrong)).toBeNull();
    const grant = await issue();
    expect(await registry.redeem(grant.capability, wrong)).toBeNull();
  });

  it("rejects an authenticated actor who is not the configured owner", async () => {
    expect(await registry.issue("user_other", binding)).toBeNull();
  });

  it("atomically consumes a capability despite concurrent redemption", async () => {
    const grant = await issue();
    const results = await Promise.all([registry.redeem(grant.capability, binding), registry.redeem(grant.capability, binding)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await registry.redeem(grant.capability, binding)).toBeNull();
  });

  it.each(["cancel", "approval", "origin", "fingerprint"] as const)("denies redemption and open-session use after %s changes", async (change) => {
    const pending = await issue();
    const grant = await issue();
    const session = await registry.redeem(grant.capability, binding);
    expect(session).not.toBeNull();
    if (change === "cancel") authority.active = false;
    if (change === "approval") authority.approvalId = "approval_replacement";
    if (change === "origin") authority.origin = "imported";
    if (change === "fingerprint") authority.fingerprint = "sha256:replacement";
    expect(await registry.redeem(pending.capability, binding)).toBeNull();
    expect(await registry.authorize(session!.credential, binding)).toBeNull();
  });

  it("honors early approval expiry after redemption", async () => {
    const session = await registry.redeem((await issue()).capability, binding);
    authority.approvalExpiresAt = now + 1;
    vi.setSystemTime(now + 1);
    expect(await registry.authorize(session!.credential, binding)).toBeNull();
  });

  it("never extends the session past the original grant TTL", async () => {
    const grant = await issue();
    vi.setSystemTime(grant.expiresAt - 1);
    const session = await registry.redeem(grant.capability, binding);
    expect(session!.expiresAt).toBe(grant.expiresAt);
    vi.setSystemTime(grant.expiresAt);
    expect(await registry.authorize(session!.credential, binding)).toBeNull();
  });

  it.each(["imported", "unknown"] as const)("denies %s origin even for an approved owner run", async (origin) => {
    authority.origin = origin;
    expect(await registry.issue(binding.ownerId, binding)).toBeNull();
  });

  it("rejects overflow rather than silently replacing a live grant", async () => {
    const first = await issue();
    await issue();
    expect(await registry.issue(binding.ownerId, binding)).toBeNull();
    expect(await registry.redeem(first.capability, binding)).not.toBeNull();
    expect(registry.size()).toBe(2);
  });

  it("cleans expired entries periodically and drains on shutdown", async () => {
    await issue();
    audit.mockClear();
    vi.advanceTimersByTime(60_000);
    // The interval sweep must have audited expiry before size() runs its own sweep.
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ event: "expired", binding }));
    expect(registry.size()).toBe(0);
    await issueExpiredApprovalControl();
    registry.close();
    expect(registry.size()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(await registry.issue(binding.ownerId, binding)).toBeNull();
  });

  async function issueExpiredApprovalControl() {
    authority.approvalExpiresAt = Date.now() + 30_000;
    return issue();
  }

  it("revokes pending and redeemed credentials for a run", async () => {
    const pending = await issue();
    const session = await registry.redeem((await issue()).capability, binding);
    registry.revokeRun(binding.runId);
    expect(await registry.redeem(pending.capability, binding)).toBeNull();
    expect(await registry.authorize(session!.credential, binding)).toBeNull();
  });

  it("does not retain credentials in audit events", async () => {
    const grant = await issue();
    const session = await registry.redeem(grant.capability, binding);
    registry.revokeRun(binding.runId);
    const events = JSON.stringify(audit.mock.calls);
    expect(events).toContain("issued");
    expect(events).toContain("redeemed");
    expect(events).toContain("revoked");
    expect(events).not.toContain(grant.capability);
    expect(events).not.toContain(session!.credential);
  });

  it("cannot resurrect an in-flight grant after shutdown", async () => {
    let release!: (value: VerificationAuthority) => void;
    const waiting = new Promise<VerificationAuthority>(resolve => { release = resolve; });
    registry.close();
    registry = new DelegatedVerificationRegistry({
      ownerId: binding.ownerId, runtimeId: binding.runtimeId, ttlMs: 30_000, maxEntries: 2,
      readAuthority: () => waiting, audit,
    });
    const pending = registry.issue(binding.ownerId, binding);
    registry.close();
    release(authority);
    expect(await pending).toBeNull();
    expect(registry.size()).toBe(0);
  });

  it("does not let a redemption capability act as a session while authority is being checked", async () => {
    let release!: (value: VerificationAuthority) => void;
    let waiting: Promise<VerificationAuthority> | null = null;
    registry.close();
    registry = new DelegatedVerificationRegistry({
      ownerId: binding.ownerId, runtimeId: binding.runtimeId, ttlMs: 30_000, maxEntries: 2,
      readAuthority: () => waiting ?? Promise.resolve(authority), audit,
    });
    const grant = await issue();
    waiting = new Promise(resolve => { release = resolve; });
    const pending = registry.redeem(grant.capability, binding);
    // A distinct lookup must not await authority for a pending redemption.
    waiting = null;
    expect(await registry.authorize(grant.capability, binding)).toBeNull();
    release(authority);
    await pending;
  });

  it("keeps an issuance awaiting authority when an unrelated run is revoked", async () => {
    let release!: (value: VerificationAuthority) => void;
    const waiting = new Promise<VerificationAuthority>(resolve => { release = resolve; });
    registry.close();
    registry = new DelegatedVerificationRegistry({
      ownerId: binding.ownerId, runtimeId: binding.runtimeId, ttlMs: 30_000, maxEntries: 2,
      readAuthority: () => waiting, audit,
    });
    const pending = registry.issue(binding.ownerId, binding);
    registry.revokeRun("run_other");
    release(authority);
    const grant = await pending;
    expect(grant).toMatchObject({ binding });
    expect(registry.size()).toBe(1);
  });

  it("completes a redemption awaiting authority when an unrelated run is revoked", async () => {
    let release!: (value: VerificationAuthority) => void;
    let waiting: Promise<VerificationAuthority> | null = null;
    registry.close();
    registry = new DelegatedVerificationRegistry({
      ownerId: binding.ownerId, runtimeId: binding.runtimeId, ttlMs: 30_000, maxEntries: 2,
      readAuthority: () => waiting ?? Promise.resolve(authority), audit,
    });
    const grant = await issue();
    waiting = new Promise(resolve => { release = resolve; });
    const pending = registry.redeem(grant.capability, binding);
    registry.revokeRun("run_other");
    release(authority);
    const session = await pending;
    expect(session).toMatchObject({ binding, expiresAt: grant.expiresAt });
    waiting = null;
    expect(await registry.authorize(session!.credential, binding)).toEqual(binding);
  });

  it("bounds concurrent issuances awaiting authority by the registry cap", async () => {
    let release!: (value: VerificationAuthority) => void;
    const waiting = new Promise<VerificationAuthority>(resolve => { release = resolve; });
    registry.close();
    registry = new DelegatedVerificationRegistry({
      ownerId: binding.ownerId, runtimeId: binding.runtimeId, ttlMs: 30_000, maxEntries: 2,
      readAuthority: () => waiting, audit,
    });
    const first = registry.issue(binding.ownerId, binding);
    const second = registry.issue(binding.ownerId, binding);
    // The third caller is denied before any await so the in-flight set stays capped.
    expect(await registry.issue(binding.ownerId, binding)).toBeNull();
    release(authority);
    expect((await Promise.all([first, second])).filter(Boolean)).toHaveLength(2);
    expect(registry.size()).toBe(2);
  });

  it("fences an issuance already awaiting authority when the run is revoked", async () => {
    let release!: (value: VerificationAuthority) => void;
    const waiting = new Promise<VerificationAuthority>(resolve => { release = resolve; });
    registry.close();
    registry = new DelegatedVerificationRegistry({
      ownerId: binding.ownerId, runtimeId: binding.runtimeId, ttlMs: 30_000, maxEntries: 2,
      readAuthority: () => waiting, audit,
    });
    const pending = registry.issue(binding.ownerId, binding);
    registry.revokeRun(binding.runId);
    release(authority);
    expect(await pending).toBeNull();
  });

  it("drains every run credential even when the audit sink fails", async () => {
    const pending = await issue();
    const session = await registry.redeem((await issue()).capability, binding);
    audit.mockImplementation(() => { throw new Error("AuditUnavailable"); });
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      registry.revokeRun(binding.runId);
      expect(registry.size()).toBe(0);
      expect(await registry.redeem(pending.capability, binding)).toBeNull();
      expect(await registry.authorize(session!.credential, binding)).toBeNull();
    } finally {
      audit.mockReset();
      log.mockRestore();
    }
  });
});
