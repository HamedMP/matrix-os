import { describe, expect, it } from 'vitest';
import { createDevstackCliPairing } from '../../packages/platform/src/devstack-cli-pairing.js';

const source = 'a'.repeat(64);
const otherSource = 'b'.repeat(64);
const target = {
  owner: 'user_owner',
  clerkSessionId: 'sess_owner',
  runtime: 'hel1-stage3',
  worktree: 'hel1-pilot',
  handle: 'hel1-preview',
  containerId: 'c'.repeat(64),
};
const ttlMs = 5 * 60_000;
const browser = { token: 'fixture-clerk-browser-token', expiresAt: Number.MAX_SAFE_INTEGER };

describe('DevStack CLI device pairing', () => {
  it('issues independent credentials and exchanges approved devices once', () => {
    const service = createDevstackCliPairing({ now: () => 1000 });
    const { approvalId, pollSecret, expiresAt } = service.create(source)!;
    expect(Buffer.from(approvalId, 'base64url')).toHaveLength(32);
    expect(Buffer.from(pollSecret, 'base64url')).toHaveLength(32);
    expect(approvalId).not.toBe(pollSecret);
    expect(service.lookupApproval(approvalId)).toEqual({ sourceIdentity: source, expiresAt });
    expect(service.lookupApproval(pollSecret)).toBeNull();
    expect(service.poll(approvalId)).toEqual({ status: 'unavailable' });
    expect(service.poll(pollSecret)).toEqual({ status: 'pending' });
    expect(service.authenticate(pollSecret)).toBeNull();
    expect(service.approve(approvalId, target, browser)).toBe(true);
    expect(service.approve(approvalId, { ...target, owner: 'user_other' }, browser)).toBe(false);
    expect(service.lookupApproval(approvalId)).toBeNull();

    const result = service.poll(pollSecret);
    expect(result).toMatchObject({ status: 'approved', expiresAt: 1000 + ttlMs });
    if (result.status !== 'approved') throw new Error('Expected an approved device.');
    expect(Buffer.from(result.bearer, 'base64url')).toHaveLength(32);
    expect(result.bearer).not.toBe(pollSecret);
    expect(service.authenticate(result.bearer)).toEqual({ ...target, sourceIdentity: source });
    expect(service.authenticate(result.bearer + '\n')).toBeNull();
    expect(service.poll(pollSecret)).toEqual({ status: 'unavailable' });
    expect(service.approve(approvalId, target, browser)).toBe(false);
  });

  it('expires unapproved devices, approved devices and issued sessions at their deadlines', () => {
    let now = 0;
    const service = createDevstackCliPairing({ now: () => now });
    const pending = service.create(source)!;
    const approved = service.create(source)!;
    const exchanged = service.create(source)!;
    expect(service.approve(approved.approvalId, target, browser)).toBe(true);
    expect(service.approve(exchanged.approvalId, { ...target, worktree: 'hel1-second' }, browser)).toBe(true);
    now = ttlMs - 1;
    const result = service.poll(exchanged.pollSecret);
    if (result.status !== 'approved') throw new Error('Expected an approved device.');
    now = ttlMs;
    expect(service.lookupApproval(pending.approvalId)).toBeNull();
    expect(service.approve(pending.approvalId, target, browser)).toBe(false);
    expect(service.poll(approved.pollSecret)).toEqual({ status: 'unavailable' });
    expect(service.authenticate(result.bearer)).not.toBeNull();
    now = result.expiresAt;
    expect(service.authenticate(result.bearer)).toBeNull();
  });

  it('never extends a source grant past the approving browser token', () => {
    let now = 1000;
    const service = createDevstackCliPairing({ now: () => now });
    const request = service.create(source)!;
    expect(service.approve(request.approvalId, target, { ...browser, expiresAt: 2000 })).toBe(true);
    const grant = service.poll(request.pollSecret);
    if (grant.status !== 'approved') throw new Error('Expected an approved device.');
    expect(grant.expiresAt).toBe(2000);
    expect(service.browserTokenFor(grant.bearer)).toBe(browser.token);
    now = 2000;
    expect(service.authenticate(grant.bearer)).toBeNull();
    expect(service.browserTokenFor(grant.bearer)).toBeUndefined();
  });

  it('releases an unpolled approval when its browser token expires', () => {
    let now = 1000;
    const service = createDevstackCliPairing({ now: () => now, maxPending: 1 });
    const abandoned = service.create(source)!;
    expect(service.approve(abandoned.approvalId, target, { ...browser, expiresAt: 2000 })).toBe(true);
    expect(service.create(source)).toBeNull();

    now = 2000;
    const retry = service.create(source)!;
    expect(retry).not.toBeNull();
    expect(service.approve(retry.approvalId, target, browser)).toBe(true);
    expect(service.poll(abandoned.pollSecret)).toEqual({ status: 'unavailable' });
    expect(service.poll(retry.pollSecret)).toMatchObject({ status: 'approved' });
  });

  it('caps pending approvals and recovers capacity after expiry without evicting live approvals', () => {
    let now = 0;
    const service = createDevstackCliPairing({ now: () => now, maxPending: 1 });
    const { approvalId } = service.create(source)!;
    expect(service.create(otherSource)).toBeNull();
    expect(service.lookupApproval(approvalId)).toMatchObject({ sourceIdentity: source });
    now = ttlMs;
    expect(service.create(otherSource)).toMatchObject({ expiresAt: now + ttlMs });
    expect(service.lookupApproval(approvalId)).toBeNull();
  });

  it('caps issued sessions and permits polling again after an issued session is revoked', () => {
    const service = createDevstackCliPairing({ maxSessions: 1 });
    const first = service.create(source)!;
    const second = service.create(otherSource)!;
    expect(service.approve(first.approvalId, target, browser)).toBe(true);
    expect(service.approve(second.approvalId, { ...target, worktree: 'hel1-second' }, browser)).toBe(true);
    const issued = service.poll(first.pollSecret);
    if (issued.status !== 'approved') throw new Error('Expected an approved device.');
    expect(service.poll(second.pollSecret)).toEqual({ status: 'capacity' });
    expect(service.revoke(issued.bearer)).toBe(true);
    expect(service.revoke(issued.bearer)).toBe(false);
    expect(service.authenticate(issued.bearer)).toBeNull();
    expect(service.poll(second.pollSecret)).toMatchObject({ status: 'approved' });
  });

  it('pins a worktree to one source and owner and rotates an exact binding on re-pair', () => {
    const service = createDevstackCliPairing({ maxSessions: 1 });
    const first = service.create(source)!;
    const other = service.create(otherSource)!;
    const rotated = service.create(source)!;
    expect(service.approve(first.approvalId, target, browser)).toBe(true);
    expect(service.approve(other.approvalId, target, browser)).toBe(false);
    const issued = service.poll(first.pollSecret);
    if (issued.status !== 'approved') throw new Error('Expected an approved device.');
    expect(service.approve(other.approvalId, target, browser)).toBe(false);
    expect(service.approve(rotated.approvalId, { ...target, owner: 'user_other' }, browser)).toBe(false);
    expect(service.approve(rotated.approvalId, { ...target, containerId: 'd'.repeat(64) }, browser)).toBe(false);
    expect(service.approve(rotated.approvalId, target, browser)).toBe(true);
    const replacement = service.poll(rotated.pollSecret);
    if (replacement.status !== 'approved') throw new Error('Expected an approved device.');
    expect(service.authenticate(issued.bearer)).toBeNull();
    expect(service.authenticate(replacement.bearer)).toEqual({ ...target, sourceIdentity: source });
  });

  it('rejects invalid source identities and malformed approval bindings', () => {
    const service = createDevstackCliPairing();
    expect(service.create('short')).toBeNull();
    expect(service.create(source + '\n')).toBeNull();
    const { approvalId } = service.create(source)!;
    expect(service.approve(approvalId, { ...target, owner: 'user_owner\n' }, browser)).toBe(false);
    expect(service.approve(approvalId, { ...target, clerkSessionId: 'user_owner' }, browser)).toBe(false);
    expect(service.approve(approvalId, { ...target, worktree: '../main' }, browser)).toBe(false);
    expect(service.approve(approvalId, target, browser)).toBe(true);
  });
});
