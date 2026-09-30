import { describe, expect, it } from 'vitest';
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
const identity = { handle: 'pr-1234', userId: 'user_owner', source: 'auth' as const };
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
