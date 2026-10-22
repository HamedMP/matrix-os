import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { BotToolRequestSchema } from '@matrix-os/contracts';
import { createManagedPiOwnerTools } from '../../packages/gateway/src/chat/managed-pi-owner-tools.js';
import type { ManagedPiRuntimeBinding } from '../../packages/gateway/src/bots/runtime-registry.js';
import type { GoogleProcessingClaim } from '../../packages/gateway/src/google-data/runtime/envelope.js';
import { getService } from '../../packages/gateway/src/integrations/registry.js';
import { storeBotGmailAttachment } from '../../packages/gateway/src/bots/integration-attachment.js';

vi.mock('../../packages/gateway/src/bots/integration-attachment.js', () => ({ storeBotGmailAttachment: vi.fn(async () => { throw new Error('Legacy attachment storage must not run'); }) }));
const account = '123e4567-e89b-42d3-a456-426614174000';
const binding = { kind: 'managed_chat', ownerId: 'owner_one', chatId: 'chat_one', runId: 'run_one', runtimeHandle: `runtime_${'a'.repeat(32)}`,
  executionGeneration: '1', capabilities: ['integration.call'], workspace: { kind: 'chat_workspace' }, rootFingerprint: 'a'.repeat(64) } as ManagedPiRuntimeBinding;
const expiresAt = new Date(Date.now() + 60_000).toISOString();
const claim: GoogleProcessingClaim = { ownerId: binding.ownerId, googleAccountId: account, runId: binding.runId, runtimeHandle: binding.runtimeHandle,
  executionGeneration: '1', profileId: '223e4567-e89b-42d3-a456-426614174000', profileRevision: 1,
  consentId: '323e4567-e89b-42d3-a456-426614174000', consentRevision: 1, purposeId: 'mail-assistance', routeDigest: 'a'.repeat(64), policyExpiresAt: expiresAt, collectionExpiresAt: expiresAt };
let home: string | undefined;
afterEach(async () => { if (home) await rm(home, { recursive: true, force: true }); home = undefined; vi.clearAllMocks(); });
it.each([1024, 160_000])('managed Gmail attachment (%i bytes) never falls back to legacy workspace storage', async size => {
  home = await mkdtemp(join(tmpdir(), 'matrix-google-no-copy-'));
  const data = { size, data: Buffer.alloc(size, 97).toString('base64url') };
  const call = vi.fn(async () => ({ data })); const controller = new AbortController();
  const tools = createManagedPiOwnerTools({ authority: async () => ({ permissionMode: 'full_access' }), signalFor: () => controller.signal,
    integrations: { call, inventory: async () => [{ connectionId: account, label: 'Work', service: 'gmail' }],
      describe: async () => Object.entries(getService('gmail')!.actions).map(([id, action]) => ({ id, description: action.description, risk: action.risk, params: action.params })) },
    googleCollection: { prepare: async () => claim } });
  await tools.open(binding, () => undefined);
  try {
    const request = BotToolRequestSchema.parse({ capability: 'integration.call', toolCallId: 'call_attachment',
      args: { service: 'gmail', connectionId: account, action: 'get_attachment', params: { messageId: 'mail_one', attachmentId: 'part_one' } } });
    if (size === 1024) {
      const result = await tools.dispatch(binding, request, controller.signal);
      const serialized = JSON.stringify(result);
      expect(serialized).toContain(data.data); expect(serialized).not.toMatch(/workspace_attachment|relPath|gmail-attachment-|consentId|routeDigest/);
    } else await expect(tools.dispatch(binding, request, controller.signal)).rejects.toThrow('Tool result exceeds limit');
    expect(call).toHaveBeenCalledWith(binding.ownerId, expect.objectContaining({ action: 'get_attachment', connectionId: account, processingClaim: claim }), expect.any(AbortSignal));
    expect(storeBotGmailAttachment).not.toHaveBeenCalled(); expect(await readdir(home)).toEqual([]);
  } finally { await tools.closeRun(binding.runId); }
});
