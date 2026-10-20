import { describe, expect, it } from 'vitest';
import { validatePrivatePreviewRegistration } from '../../scripts/ci/app-store-private-preview-registration.mjs';
const now = new Date('2026-10-19T00:00:00Z');
const owner = { id: 'owner', clerk_id: 'user_verified', handle: 'author', status: 'active' };
const machine = { machine_id: 'c44f0207-3bd8-4fc7-8c7b-836eb770103d', clerk_user_id: owner.clerk_id,
  handle: 'pv-2749-aabbccdd', runtime_slot: 'pv-2749-aabbccdd', provisioning_class: 'private-preview',
  runtime_token_epoch: 2, access_clerk_user_ids: [], source_pr: 2749, status: 'running', deleted_at: null,
  provisioned_at: '2026-10-18T12:00:00Z', confirmed_bundle_version: 'preview-version', image_version: 'preview-version',
};
const input = () => ({ owner: { ...owner }, machine: { ...machine }, expectedOwnerId: owner.clerk_id, expectedPr: 2749,
  expectedVersion: 'preview-version', membershipVerified: true, now });
describe('authoritative private-preview staging registration', () => {
  it('admits the verified owner-only active preview on the exact installed bundle', () => {
    expect(validatePrivatePreviewRegistration(input())).toMatchObject({ ownerId: owner.clerk_id, machineId: machine.machine_id, handle: machine.handle });
  });
  it('rejects shared, primary, delegated, and mismatched owner machines', () => {
    for (const patch of [{ provisioning_class: 'preview' }, { handle: 'author', runtime_slot: 'primary' },
      { access_clerk_user_ids: ['user_other'] }, { clerk_user_id: 'user_other' }, { runtime_slot: 'primary' }]) {
      expect(() => validatePrivatePreviewRegistration({ ...input(), machine: { ...machine, ...patch } })).toThrow();
    }
  });
  it('rejects unknown membership, expired/deleted/inactive/future previews, and disabled owners', () => {
    expect(() => validatePrivatePreviewRegistration({ ...input(), membershipVerified: false })).toThrow();
    expect(() => validatePrivatePreviewRegistration({ ...input(), owner: { ...owner, status: 'deleted' } })).toThrow();
    for (const patch of [{ status: 'stopped' }, { deleted_at: now.toISOString() }, { provisioned_at: '2026-10-15T00:00:00Z' },
      { provisioned_at: '2026-10-20T00:00:00Z' }, { provisioned_at: 'invalid' }]) {
      expect(() => validatePrivatePreviewRegistration({ ...input(), machine: { ...machine, ...patch } })).toThrow();
    }
  });
  it('requires exact source PR, confirmed and installed version, and valid current token epoch', () => {
    for (const patch of [{ source_pr: 123 }, { confirmed_bundle_version: 'old' }, { image_version: 'old' },
      { runtime_token_epoch: 0 }, { handle: 'pv-123-aabbccdd', runtime_slot: 'pv-123-aabbccdd' }]) {
      expect(() => validatePrivatePreviewRegistration({ ...input(), machine: { ...machine, ...patch } })).toThrow();
    }
  });
});
