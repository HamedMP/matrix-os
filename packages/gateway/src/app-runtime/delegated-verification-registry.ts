import { createHash, randomBytes } from "node:crypto";
import { z } from "zod/v4";

const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
export const VerificationBindingSchema = z.strictObject({
  ownerId: Id, runtimeId: Id, runId: Id,
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
});
export type VerificationBinding = z.infer<typeof VerificationBindingSchema>;
export interface VerificationAuthority extends VerificationBinding {
  active: boolean;
  origin: "owner-built" | "imported" | "unknown";
  approvalId: string;
  approvalExpiresAt: number;
  fingerprint: string;
}
export type VerificationAudit = {
  event: "issued" | "redeemed" | "denied" | "revoked" | "expired" | "closed";
  binding: VerificationBinding;
  at: number;
};
interface RecordEntry {
  binding: VerificationBinding;
  approvalId: string;
  fingerprint: string;
  expiresAt: number;
  phase: "pending" | "redeeming" | "session";
}
/** Tracks one awaited issuance so revocation or shutdown can fence exactly the affected run. */
interface InflightFence {
  runId: string;
  fenced: boolean;
}
interface RegistryOptions {
  ownerId: string;
  runtimeId: string;
  ttlMs: number;
  maxEntries: number;
  /** Must read verified owner/run approval and trusted app origin, not a manifest assertion. */
  readAuthority(binding: VerificationBinding): Promise<VerificationAuthority | null>;
  /** Synchronous server audit sink; never receives bearer bytes. Failures fail closed. */
  audit(event: VerificationAudit): void;
}
const Token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const same = (a: VerificationBinding, b: VerificationBinding) =>
  a.ownerId === b.ownerId && a.runtimeId === b.runtimeId && a.runId === b.runId && a.slug === b.slug;

/**
 * Process-local single-purpose authority. Pending and redeemed entries share one
 * bounded registry. Only digests persist in memory; a restart revokes everything.
 * Redemption takes its entry synchronously before awaiting the authority source,
 * so concurrent callers have one winner. Revocation fences awaited operations per
 * run: an awaited redemption requires its original record still to be present,
 * and an awaited issuance carries a run-scoped fence token. Cancelling one run
 * never denies another run's in-flight launch.
 */
export class DelegatedVerificationRegistry {
  private readonly records = new Map<string, RecordEntry>(); // cap from validated options; periodic TTL cleanup
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;
  private readonly inflight = new Set<InflightFence>(); // capped at maxEntries; cleared when each issuance settles

  constructor(private readonly options: RegistryOptions) {
    Id.parse(options.ownerId);
    Id.parse(options.runtimeId);
    z.number().int().min(1).max(30_000).parse(options.ttlMs);
    z.number().int().min(1).max(256).parse(options.maxEntries);
    this.timer = setInterval(() => this.sweep(), 1_000);
    this.timer.unref?.();
  }

  private emit(event: VerificationAudit["event"], binding: VerificationBinding) {
    this.options.audit({ event, binding: { ...binding }, at: Date.now() });
  }

  private scoped(binding: VerificationBinding) {
    return binding.ownerId === this.options.ownerId && binding.runtimeId === this.options.runtimeId;
  }

  private async authority(binding: VerificationBinding, entry?: RecordEntry) {
    const value = await this.options.readAuthority({ ...binding });
    if (this.closed || !value || !same(value, binding) || !value.active
      || value.origin !== "owner-built" || !value.approvalId || !value.fingerprint
      || !Number.isSafeInteger(value.approvalExpiresAt) || value.approvalExpiresAt <= Date.now()
      || entry && (entry.approvalId !== value.approvalId || entry.fingerprint !== value.fingerprint)) return null;
    return value;
  }

  async issue(actorId: string, rawBinding: VerificationBinding) {
    const parsed = VerificationBindingSchema.safeParse(rawBinding);
    if (this.closed || !parsed.success) return null;
    const binding = parsed.data;
    this.sweep();
    if (actorId !== this.options.ownerId || !this.scoped(binding)) {
      this.emit("denied", binding);
      return null;
    }
    if (this.inflight.size >= this.options.maxEntries) {
      this.emit("denied", binding); // bound concurrent awaited issuance like stored entries
      return null;
    }
    const fence: InflightFence = { runId: binding.runId, fenced: false };
    this.inflight.add(fence);
    try {
      const authority = await this.authority(binding);
      // Recheck the cap after awaited source reads; concurrent issuance cannot overflow.
      this.sweep();
      if (!authority || this.closed || fence.fenced || this.records.size >= this.options.maxEntries) {
        this.emit("denied", binding);
        return null;
      }
      const expiresAt = Math.min(Date.now() + this.options.ttlMs, authority.approvalExpiresAt);
      const capability = randomBytes(32).toString("base64url");
      this.emit("issued", binding); // failed audit cannot publish a credential
      if (this.closed || fence.fenced) return null;
      this.records.set(hash(capability), {
        binding, expiresAt, approvalId: authority.approvalId, fingerprint: authority.fingerprint, phase: "pending",
      });
      return { capability, binding: { ...binding }, expiresAt };
    } finally {
      this.inflight.delete(fence);
    }
  }

  async redeem(capability: string, rawBinding: VerificationBinding) {
    const parsed = VerificationBindingSchema.safeParse(rawBinding);
    if (this.closed || !parsed.success || !Token.safeParse(capability).success) return null;
    this.sweep();
    const key = hash(capability);
    const entry = this.records.get(key);
    if (!entry || entry.phase !== "pending") return null;
    // Reserve by changing phase before await. The original key is never redeemable again.
    entry.phase = "redeeming";
    if (!this.scoped(parsed.data) || !same(entry.binding, parsed.data)) {
      this.records.delete(key);
      this.emit("denied", entry.binding);
      return null;
    }
    let authority: VerificationAuthority | null;
    try {
      authority = await this.authority(parsed.data, entry);
    } catch (error) {
      this.records.delete(key);
      throw error; // route boundary must log error kind and return a generic 5xx
    }
    // Revocation of this run deletes the reserved record, so its absence is the per-run fence.
    if (!authority || this.closed || this.records.get(key) !== entry || entry.expiresAt <= Date.now()) {
      this.records.delete(key);
      this.emit("denied", entry.binding);
      return null;
    }
    const credential = randomBytes(32).toString("base64url");
    try {
      this.emit("redeemed", entry.binding);
    } finally {
      this.records.delete(key); // audit failure burns the grant, never restores replayability
    }
    if (this.closed) return null;
    entry.phase = "session";
    this.records.set(hash(credential), entry);
    return { credential, binding: { ...entry.binding }, expiresAt: entry.expiresAt };
  }

  async authorize(credential: string, rawBinding: VerificationBinding) {
    const parsed = VerificationBindingSchema.safeParse(rawBinding);
    if (this.closed || !parsed.success || !Token.safeParse(credential).success) return null;
    this.sweep();
    const key = hash(credential);
    const entry = this.records.get(key);
    if (!entry || entry.phase !== "session" || !this.scoped(parsed.data) || !same(entry.binding, parsed.data)) return null;
    const authority = await this.authority(parsed.data, entry);
    if (!authority || this.closed || this.records.get(key) !== entry || entry.expiresAt <= Date.now()) {
      this.records.delete(key);
      this.emit("denied", entry.binding);
      return null;
    }
    return { ...entry.binding };
  }

  revokeRun(runId: string) {
    for (const fence of this.inflight) {
      if (fence.runId === runId) fence.fenced = true;
    }
    const removed: VerificationBinding[] = []; // bounded by the registry cap
    for (const [key, entry] of this.records) {
      if (entry.binding.runId === runId) {
        this.records.delete(key);
        removed.push(entry.binding);
      }
    }
    for (const binding of removed) {
      try { this.emit("revoked", binding); }
      catch (error) { console.warn("[app-verification] audit unavailable", error instanceof Error ? error.name : "UnknownError"); }
    }
  }

  private sweep() {
    for (const [key, entry] of this.records) {
      if (entry.expiresAt <= Date.now()) {
        this.records.delete(key);
        try { this.emit("expired", entry.binding); }
        catch (error) { console.warn("[app-verification] audit unavailable", error instanceof Error ? error.name : "UnknownError"); }
      }
    }
  }

  size() { this.sweep(); return this.records.size; }

  close() {
    this.closed = true;
    for (const fence of this.inflight) fence.fenced = true;
    clearInterval(this.timer);
    const entries = [...this.records.values()];
    this.records.clear();
    for (const entry of entries) {
      try { this.emit("closed", entry.binding); }
      catch (error) { console.warn("[app-verification] audit unavailable", error instanceof Error ? error.name : "UnknownError"); }
    }
  }
}
