import { createHash, createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { previewDriveActionCanonical } from '@matrix-os/contracts';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createPreviewDriveRoutes, projectPreviewDriveFiles } from '../../packages/platform/src/preview-drive-routes.js';
import { mintPreviewDriveTurnProof, previewDriveTurnBodyDigest } from '../../packages/platform/src/preview-drive-turn-proof.js';
import { mintCustomMcpApprovalProof } from '../../packages/platform/src/custom-mcp-approval-proof.js';

const secret = 'platform-secret-123';
const handle = 'pr-1234';
const base = `/internal/containers/${handle}/preview-drive`;
const turnBody = { clientRequestId: 'req_one', baseRevision: 0,
  parts: [{ type: 'text', text: 'List my files' }], selection: { instanceId: 'claude_code_default', model: 'claude-sonnet-4-5' },
  interactionMode: 'default', permissionMode: 'supervised' };
const action = { service: 'google_drive', action: 'list_files', label: 'personal', params: { maxResults: 3 } };
const actionDigest = createHash('sha256').update(previewDriveActionCanonical(action)!).digest('hex');

function machineBearer(): string {
  return createHmac('sha256', secret).update(handle).digest('hex');
}

describe('Preview Drive Platform routes', () => {
  let db: PlatformDB;
  const listConnections = vi.fn(async (actorId: string) => actorId === 'user_owner'
    ? [{ service: 'google_drive', account_label: 'personal', account_email: 'private@example.com', status: 'active' }]
    : []);
  const execute = vi.fn(async () => ({ files: [
    { id: 'file1', name: 'one', mimeType: 'text/plain', secret: 'drop me' },
    { id: 'file2', name: 'two' }, { id: 'file3', name: 'three' }, { id: 'file4', name: 'four' },
  ], nextPageToken: 'private-token' }));

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await insertUserMachine(db, { machineId: '00000000-0000-4000-8000-000000002045', clerkUserId: 'user_preview_owner',
      handle, runtimeSlot: handle, provisioningClass: 'preview', accessClerkUserIds: ['user_owner', 'user_other'],
      status: 'running', provisionedAt: '2026-09-30T00:00:00.000Z' });
    listConnections.mockClear(); execute.mockClear();
  });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  function app() {
    const root = new Hono();
    root.route('/internal/containers/:handle/preview-drive', createPreviewDriveRoutes({ db, platformSecret: secret,
      integration: { listConnections, execute } }));
    return root;
  }
  function post(path: string, value: unknown, proofHeader?: Record<string, string>, bearer = machineBearer()) {
    return app().request(`${base}${path}`, { method: 'POST', headers: {
      authorization: `Bearer ${bearer}`, 'content-type': 'application/json', ...proofHeader }, body: JSON.stringify(value) });
  }
  async function redeem() {
    const proof = mintPreviewDriveTurnProof({ method: 'POST', path: '/api/chats/chat_one/turns',
      identity: { handle, userId: 'user_owner', source: 'auth' }, body: JSON.stringify(turnBody), secret });
    const value = { actorId: 'user_owner', chatId: 'chat_one', turnId: 'cturn_one', runId: 'run_one',
      clientRequestId: 'req_one', bodyDigest: previewDriveTurnBodyDigest(turnBody) };
    const response = await post('/turn/redeem', value, { 'x-matrix-preview-drive-turn-proof': proof! });
    expect(response.status).toBe(200);
    return (await response.json() as { runGrant: string }).runGrant;
  }

  it('denies machine-only, forged actor and replayed turn proof', async () => {
    const value = { actorId: 'user_owner', chatId: 'chat_one', turnId: 'cturn_one', runId: 'run_one',
      clientRequestId: 'req_one', bodyDigest: previewDriveTurnBodyDigest(turnBody) };
    expect((await post('/turn/redeem', value)).status).toBe(403);
    const proof = mintPreviewDriveTurnProof({ method: 'POST', path: '/api/chats/chat_one/turns',
      identity: { handle, userId: 'user_owner', source: 'auth' }, body: JSON.stringify(turnBody), secret });
    expect((await post('/turn/redeem', { ...value, actorId: 'user_other' },
      { 'x-matrix-preview-drive-turn-proof': proof! })).status).toBe(403);
    expect((await post('/turn/redeem', value, { 'x-matrix-preview-drive-turn-proof': proof! })).status).toBe(200);
    expect((await post('/turn/redeem', value, { 'x-matrix-preview-drive-turn-proof': proof! })).status).toBe(403);
    expect((await post('/turn/redeem', value, { 'x-matrix-preview-drive-turn-proof': proof! }, 'bad')).status).toBe(401);
  });

  it('limits discovery and a signed approval to one projected Drive inventory read', async () => {
    const runGrant = await redeem();
    const inventory = await post('/discover', { runGrant, chatId: 'chat_one', runId: 'run_one', kind: 'inventory' });
    expect(inventory.status).toBe(200);
    await expect(inventory.json()).resolves.toEqual([expect.objectContaining({ service: 'google_drive', account_label: 'personal' })]);
    const catalog = await post('/discover', { runGrant, chatId: 'chat_one', runId: 'run_one', kind: 'catalog' });
    expect(catalog.status).toBe(200);
    const services = await catalog.json() as Array<{ actions: Record<string, unknown> }>;
    expect(Object.keys(services[0]!.actions)).toEqual(['list_files']);
    const approvalBody = { clientRequestId: 'req_approval', decision: 'approve', actionDigest };
    const proof = mintCustomMcpApprovalProof({ method: 'POST', path: '/api/chats/chat_one/runs/run_one/approvals/approval_one',
      identity: { handle, userId: 'user_owner', source: 'auth' }, body: JSON.stringify(approvalBody), secret });
    expect(proof).toBeTruthy();
    const grantRequest = { runGrant, chatId: 'chat_one', runId: 'run_one', approvalId: 'approval_one',
      clientRequestId: 'req_approval', actionDigest, action };
    const grant = await post('/grants', grantRequest, { 'x-matrix-custom-mcp-approval-proof': proof! });
    expect(grant.status).toBe(200);
    const { actionGrant } = await grant.json() as { actionGrant: string };
    expect((await post('/grants', grantRequest, { 'x-matrix-custom-mcp-approval-proof': proof! })).status).toBe(403);
    const executed = await post('/execute', { runGrant, chatId: 'chat_one', runId: 'run_one', actionGrant, action });
    expect(executed.status).toBe(200);
    await expect(executed.json()).resolves.toEqual({ service: 'google_drive', action: 'list_files',
      data: { files: [{ id: 'file1', name: 'one', mimeType: 'text/plain' },
        { id: 'file2', name: 'two' }, { id: 'file3', name: 'three' }] } });
    expect(execute).toHaveBeenCalledWith('user_owner', 'personal', { maxResults: 3 });
    expect((await post('/execute', { runGrant, chatId: 'chat_one', runId: 'run_one', actionGrant, action })).status).toBe(403);
  });

  it('projects raw and SDK-wrapped Google files responses without leaking extra fields', () => {
    const source = { files: [{ id: 'file1', name: 'one', content: 'never return', parents: ['private'] },
      { id: 'file2', name: 'two' }, { id: 'file3', name: 'three' }], nextPageToken: 'secret' };
    const projected = { files: [{ id: 'file1', name: 'one' }, { id: 'file2', name: 'two' }] };
    expect(projectPreviewDriveFiles(source, 2)).toEqual(projected);
    expect(projectPreviewDriveFiles({ data: source }, 2)).toEqual(projected);
    expect(projectPreviewDriveFiles({ files: [{ id: 'file1', name: '' }] }, 1)).toBeNull();
    expect(projectPreviewDriveFiles({ files: [{ id: 'x'.repeat(257), name: 'one' }] }, 1)).toBeNull();
    expect(projectPreviewDriveFiles({ files: [{ id: 'file1', name: 'x'.repeat(1_025) }] }, 1)).toBeNull();
  });
});
