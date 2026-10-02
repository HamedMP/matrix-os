import { createHash } from 'node:crypto';
import { previewDriveActionCanonical } from '@matrix-os/contracts';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod/v4';
import type { PlatformDB, UserMachineRecord } from './db.js';
import { canClerkUserAccessMachine, getActivePreviewMachineByHandle } from './customer-vps-preview.js';
import { buildPlatformVerificationToken, timingSafeTokenEquals } from './platform-token.js';
import { readVerifiedCustomMcpApprovalProof, CUSTOM_MCP_APPROVAL_PROOF_HEADER } from './custom-mcp-approval-proof.js';
import { PREVIEW_DRIVE_TURN_PROOF_HEADER, verifyPreviewDriveTurnProof } from './preview-drive-turn-proof.js';
import { createPreviewDriveStore } from './preview-drive-store.js';

const Ref = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const Hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const Action = z.strictObject({
  service: z.literal('google_drive'), action: z.literal('list_files'),
  label: z.string().min(1).max(100).refine(value => value === value.trim()),
  params: z.strictObject({ maxResults: z.number().int().min(1).max(3) }),
});
const RunKey = z.strictObject({ runGrant: Hex64, chatId: Ref, runId: Ref });
const Redeem = z.strictObject({ actorId: z.string().min(1).max(256), chatId: Ref, turnId: Ref,
  runId: Ref, clientRequestId: Ref, bodyDigest: Hex64 });
const Discover = RunKey.extend({ kind: z.enum(['inventory', 'catalog']) });
const Grant = RunKey.extend({ approvalId: Ref, clientRequestId: Ref,
  actionDigest: Hex64, action: Action });
const Execute = RunKey.extend({ actionGrant: Hex64, action: Action });
const Revoke = RunKey;

interface DriveConnection {
  service: string;
  account_label: string;
  account_email?: string | null;
  status?: string;
}

export interface PreviewDriveIntegration {
  listConnections(actorId: string): Promise<DriveConnection[]>;
  execute(actorId: string, label: string, params: { maxResults: number }): Promise<unknown>;
}

const CATALOG = [{ id: 'google_drive', name: 'Google Drive', category: 'productivity',
  connectorKind: 'pipedream', icon: 'hard-drive', logoUrl: '',
  actions: { list_files: { description: 'List at most three Google Drive file metadata records',
    risk: 'read', params: { maxResults: { type: 'number', required: true, minimum: 1, maximum: 3 } } } } }];

function actionDigest(action: z.infer<typeof Action>): string | null {
  const canonical = previewDriveActionCanonical(action);
  return canonical ? createHash('sha256').update(canonical).digest('hex') : null;
}

export function projectPreviewDriveFiles(value: unknown, maxResults: number): { files: Record<string, unknown>[] } | null {
  const payload = value && typeof value === 'object' && 'data' in value ? value.data : value;
  if (!payload || typeof payload !== 'object' || !('files' in payload) || !Array.isArray(payload.files)) return null;
  const fields = ['id', 'name', 'mimeType', 'modifiedTime', 'size', 'webViewLink'] as const;
  const files: Record<string, unknown>[] = [];
  for (const candidate of payload.files.slice(0, maxResults) as unknown[]) {
    if (!candidate || typeof candidate !== 'object') return null;
    const source = candidate as Record<string, unknown>;
    if (typeof source.id !== 'string' || source.id.length === 0 || source.id.length > 256
      || typeof source.name !== 'string' || source.name.length === 0 || source.name.length > 1_024) return null;
    const row: Record<string, unknown> = {};
    for (const key of fields) {
      const field = source[key];
      if (typeof field === 'string' && field.length <= 2_000) row[key] = field;
    }
    files.push(row);
  }
  return { files };
}

/** Deliberately mounted outside the ordinary Preview-denying integration tree. */
export function createPreviewDriveRoutes(options: { db: PlatformDB; platformSecret: string;
  integration?: PreviewDriveIntegration }): Hono<any> {
  const app = new Hono<{ Variables: { previewDriveHandle: string; previewDriveMachine: UserMachineRecord } }>();
  const store = createPreviewDriveStore(options.db);

  app.use('*', bodyLimit({ maxSize: 4_000 }), async (c, next) => {
    const handle = c.req.param('handle');
    if (!handle || !/^pr-[1-9][0-9]{0,8}$/.test(handle) || !options.platformSecret) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const bearer = c.req.header('authorization');
    const token = bearer?.startsWith('Bearer ') ? bearer.slice(7) : undefined;
    if (!timingSafeTokenEquals(token, buildPlatformVerificationToken(handle, options.platformSecret))) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const machine = await getActivePreviewMachineByHandle(options.db, handle);
    if (!machine || machine.status !== 'running') return c.json({ error: 'Forbidden' }, 403);
    c.set('previewDriveHandle', handle);
    c.set('previewDriveMachine', machine);
    await next();
  });

  async function parseBody<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T> | null> {
    let value: unknown;
    try { value = await c.req.json(); }
    catch (error: unknown) {
      if (!(error instanceof SyntaxError)) console.warn('[preview-drive] Invalid body', error instanceof Error ? error.name : typeof error);
      return null;
    }
    const parsed = schema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }

  app.post('/turn/redeem', async c => {
    const body = await parseBody(c, Redeem);
    if (!body) return c.json({ error: 'Invalid request' }, 400);
    if (!options.integration) return c.json({ error: 'Unavailable' }, 503);
    const handle = c.get('previewDriveHandle');
    const machine = c.get('previewDriveMachine');
    if (!machine || !canClerkUserAccessMachine(machine, body.actorId)) return c.json({ error: 'Forbidden' }, 403);
    const proof = verifyPreviewDriveTurnProof(c.req.header(PREVIEW_DRIVE_TURN_PROOF_HEADER), {
      handle, actorId: body.actorId, chatId: body.chatId, clientRequestId: body.clientRequestId,
      bodyDigest: body.bodyDigest, secret: options.platformSecret,
    });
    if (!proof) return c.json({ error: 'Forbidden' }, 403);
    const runGrant = await store.redeemTurn({ proofNonce: proof.nonce, handle, actorId: proof.actorId,
      chatId: body.chatId, turnId: body.turnId, runId: body.runId,
      clientRequestId: body.clientRequestId, bodyDigest: body.bodyDigest });
    return runGrant ? c.json({ runGrant }) : c.json({ error: 'Forbidden' }, 403);
  });

  app.post('/discover', async c => {
    const body = await parseBody(c, Discover);
    if (!body) return c.json({ error: 'Invalid request' }, 400);
    if (!options.integration) return c.json({ error: 'Unavailable' }, 503);
    const handle = c.get('previewDriveHandle');
    const run = await store.getRun({ token: body.runGrant, handle, chatId: body.chatId, runId: body.runId });
    const machine = c.get('previewDriveMachine');
    if (!run || !machine || !canClerkUserAccessMachine(machine, run.actorId)) return c.json({ error: 'Forbidden' }, 403);
    try {
      const connected = (await options.integration.listConnections(run.actorId))
        .filter(row => row.service === 'google_drive' && row.status === 'active'
          && row.account_label.length > 0 && row.account_label.length <= 100).slice(0, 16);
      if (body.kind === 'catalog') return c.json(connected.length ? CATALOG : []);
      return c.json(connected.map(row => ({ service: 'google_drive', account_label: row.account_label,
        status: 'active' })));
    } catch (error: unknown) {
      console.warn('[preview-drive] Discovery unavailable', error instanceof Error ? error.name : typeof error);
      return c.json({ error: 'Unavailable' }, 503);
    }
  });

  app.post('/grants', async c => {
    const body = await parseBody(c, Grant);
    if (!body) return c.json({ error: 'Invalid request' }, 400);
    if (!options.integration) return c.json({ error: 'Unavailable' }, 503);
    const handle = c.get('previewDriveHandle');
    const run = await store.getRun({ token: body.runGrant, handle, chatId: body.chatId, runId: body.runId });
    const machine = c.get('previewDriveMachine');
    if (!run || !machine || !canClerkUserAccessMachine(machine, run.actorId)) return c.json({ error: 'Forbidden' }, 403);
    const exactDigest = actionDigest(body.action);
    if (!exactDigest || exactDigest !== body.actionDigest) return c.json({ error: 'Forbidden' }, 403);
    const proof = readVerifiedCustomMcpApprovalProof(c.req.header(CUSTOM_MCP_APPROVAL_PROOF_HEADER), {
      handle, actorId: run.actorId, chatId: body.chatId, runId: body.runId,
      approvalId: body.approvalId, clientRequestId: body.clientRequestId,
      decision: 'approve', actionDigest: exactDigest, secret: options.platformSecret,
    });
    if (!proof) return c.json({ error: 'Forbidden' }, 403);
    try {
      const connected = await options.integration.listConnections(run.actorId);
      if (connected.filter(row => row.service === 'google_drive' && row.status === 'active'
        && row.account_label === body.action.label).length !== 1) {
        return c.json({ error: 'Forbidden' }, 403);
      }
      const actionGrant = await store.issueAction({ runGrant: body.runGrant, proofNonce: proof.nonce,
        handle, actorId: run.actorId, chatId: body.chatId, runId: body.runId,
        actionDigest: exactDigest, label: body.action.label, maxResults: body.action.params.maxResults });
      return actionGrant ? c.json({ actionGrant }) : c.json({ error: 'Forbidden' }, 403);
    } catch (error: unknown) {
      console.warn('[preview-drive] Approval unavailable', error instanceof Error ? error.name : typeof error);
      return c.json({ error: 'Unavailable' }, 503);
    }
  });

  app.post('/execute', async c => {
    const body = await parseBody(c, Execute);
    if (!body) return c.json({ error: 'Invalid request' }, 400);
    if (!options.integration) return c.json({ error: 'Unavailable' }, 503);
    const handle = c.get('previewDriveHandle');
    const exactDigest = actionDigest(body.action);
    if (!exactDigest) return c.json({ error: 'Forbidden' }, 403);
    const consumed = await store.consumeAction({ runGrant: body.runGrant, grant: body.actionGrant,
      handle, chatId: body.chatId, runId: body.runId, actionDigest: exactDigest,
      label: body.action.label, maxResults: body.action.params.maxResults });
    const machine = c.get('previewDriveMachine');
    if (!consumed || !machine || !canClerkUserAccessMachine(machine, consumed.actorId)) return c.json({ error: 'Forbidden' }, 403);
    try {
      const raw = await options.integration.execute(consumed.actorId, body.action.label, body.action.params);
      const data = projectPreviewDriveFiles(raw, body.action.params.maxResults);
      return data ? c.json({ data, service: 'google_drive', action: 'list_files' })
        : c.json({ error: 'Unavailable' }, 502);
    } catch (error: unknown) {
      console.warn('[preview-drive] Read unavailable', error instanceof Error ? error.name : typeof error);
      return c.json({ error: 'Unavailable' }, 502);
    }
  });

  app.post('/revoke', async c => {
    const body = await parseBody(c, Revoke);
    if (!body) return c.json({ error: 'Invalid request' }, 400);
    const handle = c.get('previewDriveHandle');
    const revoked = await store.revokeRun({ token: body.runGrant, handle, chatId: body.chatId, runId: body.runId });
    return c.json({ revoked: revoked > 0 });
  });

  return app;
}
