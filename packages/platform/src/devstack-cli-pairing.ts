import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod/v4';
import { DevstackClerkUserIdSchema, DevstackContainerIdSchema, DevstackInstanceSchema } from './devstack-identity.js';
import { HANDLE_PATTERN } from './platform-route-utils.js';

const ttlMs = 5 * 60_000;
const maximumPending = 128;
const maximumSessions = 24;
const approvalSchema = z.strictObject({
  owner: DevstackClerkUserIdSchema.refine(value => !value.includes('\n')),
  clerkSessionId: z.string().regex(/^sess_[A-Za-z0-9_]{1,128}$/).refine(value => !value.includes('\n')),
  runtime: DevstackInstanceSchema.refine(value => !value.includes('\n')),
  worktree: DevstackInstanceSchema.refine(value => !value.includes('\n')),
  handle: z.string().regex(HANDLE_PATTERN).refine(value => !value.includes('\n')),
  containerId: DevstackContainerIdSchema,
});

type Approval = z.infer<typeof approvalSchema>;
export type DevstackCliBinding = Readonly<Approval & { sourceIdentity: string }>;

interface Pending {
  sourceIdentity: string;
  expiresAt: number;
  pollDigest: Buffer;
  approval?: { binding: DevstackCliBinding; browserToken: string; browserExpiresAt: number };
}

interface Session {
  binding: DevstackCliBinding;
  browserToken: string;
  expiresAt: number;
}

type PollResult =
  | { status: 'pending' | 'unavailable' | 'capacity' }
  | { status: 'approved'; bearer: string; expiresAt: number; binding: DevstackCliBinding };

const secretPattern = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const isSecret = (value: string) => value.length === 43 && secretPattern.test(value);
const generateSecret = () => randomBytes(32).toString('base64url');
const digest = (secret: string) => createHash('sha256').update(secret).digest();

function capacity(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error('Invalid DevStack CLI pairing capacity.');
  }
  return value;
}

function sameSourceAndTarget(first: DevstackCliBinding, next: DevstackCliBinding): boolean {
  return first.owner === next.owner && first.sourceIdentity === next.sourceIdentity
    && first.runtime === next.runtime && first.worktree === next.worktree
    && first.handle === next.handle && first.containerId === next.containerId;
}

/**
 * Single-process pairing state for the isolated DevStack Platform. The caller
 * must verify a current Clerk session, membership and registry target before
 * approving. A bearer identifies an approval, so each protected operation
 * still has to check its live authorization and source/target registration.
 */
export function createDevstackCliPairing(options: {
  now?: () => number;
  maxPending?: number;
  maxSessions?: number;
} = {}) {
  const now = options.now ?? Date.now;
  const pendingLimit = capacity(options.maxPending, maximumPending);
  const sessionLimit = capacity(options.maxSessions, maximumSessions);
  const pending = new Map<string, Pending>();
  const sessions = new Map<Buffer, Session>();

  function sweep<T extends { expiresAt: number }, K>(records: Map<K, T>, timestamp: number) {
    for (const [key, record] of records) {
      if (record.expiresAt <= timestamp) records.delete(key);
    }
  }

  function create(sourceIdentity: string) {
    if (sourceIdentity.length !== 64 || !/^[0-9a-f]+$/.test(sourceIdentity)) return null;
    const timestamp = now();
    sweep(pending, timestamp);
    if (pending.size >= pendingLimit) return null;

    const approvalId = generateSecret();
    const pollSecret = generateSecret();
    if (pending.has(approvalId)) return null;
    const expiresAt = timestamp + ttlMs;
    pending.set(approvalId, { sourceIdentity, expiresAt, pollDigest: digest(pollSecret) });
    return { approvalId, pollSecret, expiresAt };
  }

  function unapproved(approvalId: string): Pending | undefined {
    if (!isSecret(approvalId)) return;
    const record = pending.get(approvalId);
    if (!record || record.approval) return;
    if (record.expiresAt <= now()) {
      pending.delete(approvalId);
      return;
    }
    return record;
  }

  function lookupApproval(approvalId: string) {
    const record = unapproved(approvalId);
    return record ? { sourceIdentity: record.sourceIdentity, expiresAt: record.expiresAt } : null;
  }

  function activeForWorktree(worktree: string) {
    for (const [key, session] of sessions) {
      if (session.binding.worktree === worktree) return { key, binding: session.binding };
    }
  }

  function approve(approvalId: string, approval: Approval, browser: { token: string; expiresAt: number }): boolean {
    const timestamp = now();
    sweep(pending, timestamp);
    sweep(sessions, timestamp);
    const record = unapproved(approvalId);
    const parsed = approvalSchema.safeParse(approval);
    if (!record || !parsed.success || (!browser.token || browser.token.length > 8192 ||
      !Number.isSafeInteger(browser.expiresAt) || browser.expiresAt <= timestamp)) return false;

    const binding = Object.freeze({ ...parsed.data, sourceIdentity: record.sourceIdentity });
    if ([...pending.values()].some(candidate => candidate.approval?.binding.worktree === binding.worktree)) return false;
    const active = activeForWorktree(binding.worktree);
    if (active && !sameSourceAndTarget(active.binding, binding)) return false;

    record.approval = { binding, browserToken: browser.token, browserExpiresAt: browser.expiresAt };
    record.expiresAt = Math.min(record.expiresAt, browser.expiresAt);
    return true;
  }

  function poll(pollSecret: string): PollResult {
    if (!isSecret(pollSecret)) return { status: 'unavailable' };
    const timestamp = now();
    sweep(pending, timestamp);
    sweep(sessions, timestamp);
    const presented = digest(pollSecret);
    for (const [approvalId, record] of pending) {
      if (!timingSafeEqual(record.pollDigest, presented)) continue;
      const approval = record.approval;
      if (!approval) return { status: 'pending' };
      const { binding, browserToken } = approval;
      const prior = activeForWorktree(binding.worktree);
      if (!prior && sessions.size >= sessionLimit) return { status: 'capacity' };
      const bearer = generateSecret();
      const expiresAt = Math.min(timestamp + ttlMs, approval.browserExpiresAt);
      if (prior) sessions.delete(prior.key);
      pending.delete(approvalId);
      sessions.set(digest(bearer), { binding, browserToken, expiresAt });
      return { status: 'approved', bearer, expiresAt, binding };
    }
    return { status: 'unavailable' };
  }

  function findSessionKey(bearer: string): Buffer | undefined {
    if (!isSecret(bearer)) return;
    sweep(sessions, now());
    const presented = digest(bearer);
    for (const key of sessions.keys()) {
      if (timingSafeEqual(key, presented)) return key;
    }
  }

  function authenticate(bearer: string): DevstackCliBinding | null {
    const key = findSessionKey(bearer);
    return key ? sessions.get(key)!.binding : null;
  }

  function browserTokenFor(bearer: string): string | undefined {
    const key = findSessionKey(bearer);
    return key ? sessions.get(key)?.browserToken : undefined;
  }

  function authorityFor(bearer: string) {
    const key = findSessionKey(bearer);
    const session = key && sessions.get(key);
    return session ? { token: session.browserToken, expiresAt: session.expiresAt } : undefined;
  }

  function revoke(bearer: string): boolean {
    const key = findSessionKey(bearer);
    return key !== undefined && sessions.delete(key);
  }

  return { create, lookupApproval, approve, poll, authenticate, browserTokenFor, authorityFor, revoke };
}
