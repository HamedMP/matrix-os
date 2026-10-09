import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod/v4';
import type { AtsDB } from './ats-db.js';
import { AtsMailSchema, importAtsMail, listAtsInbox, promoteAtsMail } from './ats-mail.js';
import { timingSafeTokenEquals } from './platform-token.js';
import { AtsApplicationNotFoundError } from './ats-errors.js';
import { LegacyCandidateSchema, importLegacyCandidate } from './ats-legacy.js';
import { getAtsMailAttachment } from './ats-attachments.js';

export function createAtsMailRoutes(options: { db: AtsDB; mailSecret: string; allowedRoleSlugs: readonly string[] }) {
  const app = new Hono();
  // This is a separate scoped bridge credential; it cannot read or mutate the hiring pipeline.
  app.post('/api/ats/mail', bodyLimit({ maxSize: 8 * 1024 * 1024 }), async (c) => {
    if (!options.mailSecret) return c.json({ error: 'Email intake unavailable' }, 503);
    const token = c.req.header('authorization')?.replace(/^Bearer /, '');
    if (!timingSafeTokenEquals(token, options.mailSecret)) return c.json({ error: 'Unauthorized' }, 401);
    try {
      const input = AtsMailSchema.safeParse(await c.req.json());
      if (!input.success) return c.json({ error: 'Invalid email' }, 422);
      const mail = await importAtsMail(options.db, input.data, new Date().toISOString());
      return c.json({ receiptId: mail.id });
    } catch (error) {
      if (error instanceof Error && error.name === 'BodyLimitError') throw error;
      if (error instanceof SyntaxError) return c.json({ error: 'Invalid email' }, 422);
      console.error('[ats] Mail intake failed:', error instanceof Error ? error.name : typeof error);
      return c.json({ error: 'Email intake unavailable' }, 503);
    }
  });
  // Mounted beneath the existing admin-secret middleware.
  app.post('/api/ats/admin/legacy-inbox', bodyLimit({ maxSize: 8 * 1024 * 1024 }), async (c) => {
    try {
      const input = AtsMailSchema.safeParse(await c.req.json());
      if (!input.success) return c.json({ error: 'Invalid recruiting history' }, 422);
      const mail = await importAtsMail(options.db, input.data, new Date().toISOString(), { notify: false });
      return c.json({ receiptId: mail.id });
    } catch (error) {
      if (error instanceof Error && error.name === 'BodyLimitError') throw error;
      if (error instanceof SyntaxError) return c.json({ error: 'Invalid recruiting history' }, 422);
      console.error('[ats] Inbox history import failed:', error instanceof Error ? error.name : typeof error);
      return c.json({ error: 'History import unavailable' }, 503);
    }
  });
  app.post('/api/ats/admin/legacy-import', bodyLimit({ maxSize: 8 * 1024 * 1024 }), async (c) => {
    try {
      const input = LegacyCandidateSchema.safeParse(await c.req.json());
      const actor = z.string().min(1).max(200).safeParse(c.req.header('x-ats-actor-id'));
      if (!input.success || !actor.success) return c.json({ error: 'Invalid recruiting history' }, 422);
      return c.json({ application: await importLegacyCandidate(options.db, input.data, actor.data, new Date().toISOString()) });
    } catch (error) {
      if (error instanceof Error && error.name === 'BodyLimitError') throw error;
      if (error instanceof SyntaxError) return c.json({ error: 'Invalid recruiting history' }, 422);
      console.error('[ats] History import failed:', error instanceof Error ? error.name : typeof error);
      return c.json({ error: 'History import unavailable' }, 503);
    }
  });
  app.get('/api/ats/admin/attachments/:id', async (c) => {
    const id = z.uuid().safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: 'Invalid file' }, 422);
    try {
      const file = await getAtsMailAttachment(options.db, id.data);
      if (!file) return c.json({ error: 'Not found' }, 404);
      return new Response(file.bytes as BodyInit, { headers: { 'content-type': file.content_type, 'content-disposition': `attachment; filename="${file.filename}"`, 'cache-control': 'no-store, private', 'x-content-type-options': 'nosniff' } });
    } catch (error) {
      if (error instanceof Error && error.name === 'BodyLimitError') throw error;
      console.error('[ats] Attachment read failed:', error instanceof Error ? error.name : typeof error);
      return c.json({ error: 'File unavailable' }, 503);
    }
  });
  app.get('/api/ats/admin/inbox', async (c) => {
    try { return c.json({ messages: await listAtsInbox(options.db) }); }
    catch (error) {
      console.error('[ats] Inbox read failed:', error instanceof Error ? error.name : typeof error);
      return c.json({ error: 'Inbox unavailable' }, 503);
    }
  });
  app.post('/api/ats/admin/inbox/:id/promote', bodyLimit({ maxSize: 4096 }), async (c) => {
    const id = z.uuid().safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: 'Invalid email' }, 422);
    try {
      const input = z.object({ roleSlug: z.string().max(100).refine((v) => options.allowedRoleSlugs.includes(v)) }).safeParse(await c.req.json());
      if (!input.success) return c.json({ error: 'Invalid role' }, 422);
      const actor = z.string().trim().min(1).max(200).safeParse(c.req.header('x-ats-actor-id'));
      if (!actor.success) return c.json({ error: 'Invalid reviewer' }, 422);
      return c.json({ application: await promoteAtsMail(options.db, id.data, input.data.roleSlug, actor.data, new Date().toISOString()) });
    } catch (error) {
      if (error instanceof Error && error.name === 'BodyLimitError') throw error;
      if (error instanceof SyntaxError) return c.json({ error: 'Invalid email' }, 422);
      if (error instanceof AtsApplicationNotFoundError) return c.json({ error: 'Not found' }, 404);
      console.error('[ats] Inbox promotion failed:', error instanceof Error ? error.name : typeof error);
      return c.json({ error: 'Email review unavailable' }, 503);
    }
  });
  return app;
}
