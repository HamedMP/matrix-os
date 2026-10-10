import { describe, expect, it, vi } from 'vitest';
import { authenticatedPreviewDriveProxyProof } from '../../packages/platform/src/preview-drive-proxy-proof.js';
import { authenticatedApprovalProxyProof } from '../../packages/platform/src/session-routing-middleware.js';
import { createHash } from 'node:crypto';
import { canonicalPreviewDriveTurnBody } from '@matrix-os/contracts';
import {
  mintPreviewDriveTurnProof,
  verifyPreviewDriveTurnProof,
} from '../../packages/platform/src/preview-drive-turn-proof.js';

const body = JSON.stringify({
  clientRequestId: 'req_one', baseRevision: 0,
  parts: [{ type: 'text', text: 'List my files' }],
  selection: { instanceId: 'claude_code_default', model: 'claude-sonnet-4-5' },
  interactionMode: 'default', permissionMode: 'supervised',
});
const identity = { handle: 'pr-1234', userId: 'user_owner', source: 'auth' as const, sessionProvenance: 'clerk-browser' as const };
const secret = 'platform-secret-123';

describe('Preview Drive turn proof', () => {
  it('binds a browser-authenticated turn to actor, handle, chat, request and body', () => {
    const proof = mintPreviewDriveTurnProof({
      method: 'POST', path: '/api/chats/chat_one/turns', identity, body, secret, now: 1_000,
    });
    expect(proof).toBeTruthy();
    const verified = verifyPreviewDriveTurnProof(proof, {
      handle: 'pr-1234', actorId: 'user_owner', chatId: 'chat_one',
      clientRequestId: 'req_one', bodyDigest: verifiedBodyDigest(body), secret, now: 1_001,
    });
    expect(verified).toMatchObject({ actorId: 'user_owner', handle: 'pr-1234', chatId: 'chat_one' });
    expect(verified?.nonce).toMatch(/^[a-f0-9]{32}$/);
    for (const mismatch of [
      { actorId: 'user_other' }, { handle: 'pr_other' }, { chatId: 'chat_other' },
      { clientRequestId: 'req_other' }, { bodyDigest: 'a'.repeat(64) },
    ]) {
      expect(verifyPreviewDriveTurnProof(proof, {
        handle: 'pr-1234', actorId: 'user_owner', chatId: 'chat_one',
        clientRequestId: 'req_one', bodyDigest: verifiedBodyDigest(body), secret, now: 1_001, ...mismatch,
      })).toBeNull();
    }
  });

  it('rejects a machine-only source, malformed body, expired proof, and tampering', () => {
    expect(mintPreviewDriveTurnProof({ method: 'POST', path: '/api/chats/chat_one/turns',
      identity: { ...identity, source: 'static-route' }, body, secret })).toBeNull();
    expect(mintPreviewDriveTurnProof({ method: 'POST', path: '/api/chats/chat_one/turns',
      identity, body: '{}', secret })).toBeNull();
    const proof = mintPreviewDriveTurnProof({ method: 'POST', path: '/api/chats/chat_one/turns',
      identity, body, secret, now: 1_000 });
    const expected = { handle: 'pr-1234', actorId: 'user_owner', chatId: 'chat_one',
      clientRequestId: 'req_one', bodyDigest: verifiedBodyDigest(body), secret };
    expect(verifyPreviewDriveTurnProof(proof, { ...expected, now: 61_001 })).toBeNull();
    expect(verifyPreviewDriveTurnProof(`${proof}x`, { ...expected, now: 1_001 })).toBeNull();
  });

  it.each(['clerk-device', 'clerk-browser'] as const)('accepts verified %s across transports, without relaxing turn mode', sessionProvenance => {
    for (const verifiedSyncBearer of [true, false]) {
      const trusted = { ...identity, sessionProvenance, verifiedSyncBearer };
      expect(mintPreviewDriveTurnProof({ method: 'POST', path: '/api/chats/chat_one/turns', identity: trusted, body, secret })).toBeTruthy();
      for (const patch of [{ permissionMode: 'fullAccess' }, { interactionMode: 'plan' },
        { selection: { instanceId: 'codex_default', model: 'gpt' } }]) {
        expect(mintPreviewDriveTurnProof({ method: 'POST', path: '/api/chats/chat_one/turns', identity: trusted,
          body: JSON.stringify({ ...JSON.parse(body), ...patch }), secret })).toBeNull();
      }
    }
  });

  it('denies missing provenance and unauthenticated sources even with a user-session marker', () => {
    for (const verifiedSyncBearer of [true, false]) expect(mintPreviewDriveTurnProof({ method: 'POST',
      path: '/api/chats/chat_one/turns', identity: { ...identity, sessionProvenance: undefined, verifiedSyncBearer }, body, secret })).toBeNull();
    for (const source of ['mobile-session', 'static-route', undefined] as const) expect(mintPreviewDriveTurnProof({ method: 'POST',
      path: '/api/chats/chat_one/turns', identity: { ...identity, source }, body, secret })).toBeNull();
  });

  it.each(['turn', 'approval'])('does not mint a %s proof when the verified user session expires during body reading', async kind => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
      const path = kind === 'turn' ? '/api/chats/chat_one/turns' : '/api/chats/chat_one/runs/run_one/approvals/approval_one';
      const request = new Request(`https://app.example.test${path}`, { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
      const common = { request, method: 'POST', path, identity: { ...identity, sessionExpiresAt: 1_001 },
        machine: { handle: 'pr-1234', runtimeSlot: 'pr-1234', provisioningClass: 'preview' as const }, platformSecret: secret };
      const pending = kind === 'turn' ? authenticatedPreviewDriveProxyProof(common)
        : authenticatedApprovalProxyProof({ ...common, handle: 'pr-1234' });
      clock.mockReturnValue(1_001_001);
      controller.enqueue(new TextEncoder().encode(kind === 'turn' ? body
        : JSON.stringify({ clientRequestId: 'req_one', decision: 'approve', actionDigest: 'a'.repeat(64) })));
      controller.close();
      expect(await pending).toBeNull();
    } finally { clock.mockRestore(); }
  });

  it('accepts a valid turn above 64 KiB within the Gateway 128 KiB limit', () => {
    const large = { ...JSON.parse(body), parts: [
      { type: 'text', text: 'a'.repeat(25_000) },
      { type: 'text', text: 'b'.repeat(25_000) },
      { type: 'text', text: 'c'.repeat(25_000) },
    ] };
    const proof = mintPreviewDriveTurnProof({ method: 'POST', path: '/api/chats/chat_one/turns',
      identity, body: JSON.stringify(large), secret });
    expect(proof).toBeTruthy();
    expect(verifyPreviewDriveTurnProof(proof, { handle: 'pr-1234', actorId: 'user_owner',
      chatId: 'chat_one', clientRequestId: 'req_one', bodyDigest: verifiedBodyDigest(JSON.stringify(large)), secret }))
      .toBeTruthy();
  });
});

function verifiedBodyDigest(raw: string): string {
  return createHash('sha256').update(canonicalPreviewDriveTurnBody(JSON.parse(raw))).digest('hex');
}
