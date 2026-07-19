import { createHash, randomBytes } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod/v4';
import {
  AtsApplicationNotFoundError,
  AtsRevisionConflictError,
  addAtsNote,
  completeAtsTask,
  createAtsApplication,
  createAtsInterview,
  createAtsTask,
  getAtsApplication,
  getAtsApplicationResume,
  listAtsApplications,
  resolveAtsBooking,
  transitionAtsApplication,
  updateAtsApplicationMetadata,
  upsertAtsScorecard,
} from './ats-repository.js';
import { ATS_DISPOSITIONS, ATS_STAGES } from './ats-types.js';
import type { AtsDB } from './ats-db.js';
import { timingSafeTokenEquals } from './platform-token.js';

const APPLICATION_BODY_LIMIT = 6 * 1024 * 1024;
const RESUME_SIZE_LIMIT = 5 * 1024 * 1024;
const ADMIN_BODY_LIMIT = 64 * 1024;

const HttpUrlSchema = z.string().max(2_048).url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === 'https:' || protocol === 'http:';
});

const LinksSchema = z.record(z.string().min(1).max(50), HttpUrlSchema).refine(
  (links) => Object.keys(links).length <= 10,
);
const AnswersSchema = z.array(z.object({
  prompt: z.string().trim().min(1).max(500),
  answer: z.string().trim().min(1).max(5_000),
})).min(1).max(10);

const TransitionSchema = z.object({
  baseRevision: z.number().int().positive(),
  stage: z.enum(ATS_STAGES),
  disposition: z.enum(ATS_DISPOSITIONS),
  reason: z.string().trim().max(2_000).nullable().default(null),
});

const NoteSchema = z.object({ body: z.string().trim().min(1).max(10_000) });
const ScorecardSchema = z.object({
  interviewType: z.string().trim().min(1).max(100),
  recommendation: z.enum(['strong_no', 'no', 'mixed', 'yes', 'strong_yes']),
  ratings: z.record(z.string().min(1).max(50), z.number().int().min(1).max(5)).refine(
    (ratings) => Object.keys(ratings).length <= 20,
  ),
  strengths: z.string().trim().min(1).max(10_000),
  concerns: z.string().trim().max(10_000).nullable().default(null),
});
const InterviewSchema = z.object({
  interviewType: z.string().trim().min(1).max(100),
  interviewerIds: z.array(z.string().trim().min(1).max(200)).min(1).max(20),
});
const TaskSchema = z.object({
  title: z.string().trim().min(1).max(500),
  assigneeId: z.string().trim().min(1).max(200).nullable().default(null),
  dueAt: z.iso.datetime().nullable().default(null),
});
const MetadataSchema = z.object({
  baseRevision: z.number().int().positive(),
  ownerId: z.string().trim().min(1).max(200).nullable(),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).transform((tags) => [...new Set(tags)]),
  nextActionAt: z.iso.datetime().nullable(),
});
const BookingTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

function bearerToken(header: string | undefined): string | undefined {
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
}

function safeFilename(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._ -]/g, '_').replace(/\s+/g, ' ').trim();
  return sanitized.slice(0, 180) || 'resume';
}

function isAllowedResumeSignature(contentType: string, bytes: Uint8Array): boolean {
  if (contentType === 'application/pdf') {
    return bytes.length >= 4 && new TextDecoder().decode(bytes.slice(0, 4)) === '%PDF';
  }
  if (contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  }
  if (contentType === 'application/msword') {
    const signature = [0xd0, 0xcf, 0x11, 0xe0];
    return bytes.length >= 4 && signature.every((byte, index) => bytes[index] === byte);
  }
  return false;
}

async function readJson<T>(c: { req: { json(): Promise<unknown> } }, schema: z.ZodType<T>): Promise<T | null> {
  const raw = await c.req.json().catch((err: unknown) => {
    console.warn('[ats] Invalid JSON request:', err instanceof Error ? err.name : typeof err);
    return undefined;
  });
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function getActorId(headers: { get(name: string): string | null }): string {
  const raw = headers.get('x-ats-actor-id')?.trim();
  return raw && raw.length <= 200 ? raw : 'site-admin';
}

function adminRouteError(c: Context, operation: string, err: unknown) {
  if (err instanceof AtsApplicationNotFoundError) {
    return c.json({ error: 'Not found' }, 404);
  }
  console.error(`[ats] ${operation} failed:`, err instanceof Error ? err.message : String(err));
  return c.json({ error: 'ATS operation failed' }, 503);
}

export function createAtsRoutes(options: {
  db: AtsDB;
  ingestSecret: string;
  adminSecret: string;
  allowedRoleSlugs: readonly string[];
  bookingBaseUrl?: string;
  publicSiteUrl?: string;
  now?: () => Date;
}): Hono {
  const app = new Hono();
  const now = options.now ?? (() => new Date());

  function requireSecret(c: Parameters<Parameters<typeof app.use>[1]>[0], secret: string, kind: string) {
    if (!secret) return c.json({ error: `${kind} not configured` }, 503);
    if (!timingSafeTokenEquals(bearerToken(c.req.header('authorization')), secret)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return null;
  }

  app.post('/api/ats/applications', bodyLimit({ maxSize: APPLICATION_BODY_LIMIT }), async (c) => {
    const authError = requireSecret(c, options.ingestSecret, 'Application intake');
    if (authError) return authError;
    try {
      const form = await c.req.formData();
      const roleSlug = String(form.get('roleSlug') ?? '');
      const linksParsed = LinksSchema.safeParse(JSON.parse(String(form.get('links') ?? '{}')));
      const answersParsed = AnswersSchema.safeParse(JSON.parse(String(form.get('answers') ?? '[]')));
      const fields = z.object({
        submissionKey: z.uuid(),
        candidateName: z.string().trim().min(1).max(200),
        candidateEmail: z.email().max(320),
        phone: z.string().trim().max(100).nullable(),
        location: z.string().trim().min(1).max(300),
        availability: z.string().trim().min(1).max(1_000),
        source: z.string().trim().min(1).max(100),
        consent: z.literal('true'),
      }).safeParse({
        submissionKey: String(form.get('submissionKey') ?? ''),
        candidateName: String(form.get('candidateName') ?? ''),
        candidateEmail: String(form.get('candidateEmail') ?? ''),
        phone: form.get('phone') ? String(form.get('phone')) : null,
        location: String(form.get('location') ?? ''),
        availability: String(form.get('availability') ?? ''),
        source: String(form.get('source') ?? 'careers_page'),
        consent: String(form.get('consent') ?? ''),
      });
      const resume = form.get('resume');
      if (
        !options.allowedRoleSlugs.includes(roleSlug) ||
        !fields.success ||
        !linksParsed.success ||
        !answersParsed.success ||
        !(resume instanceof File) ||
        resume.size === 0 ||
        resume.size > RESUME_SIZE_LIMIT
      ) {
        return c.json({ error: 'Invalid application' }, 422);
      }
      const resumeBytes = new Uint8Array(await resume.arrayBuffer());
      if (!isAllowedResumeSignature(resume.type, resumeBytes)) {
        return c.json({ error: 'Invalid application' }, 422);
      }
      const submittedAt = now();
      const retentionUntil = new Date(submittedAt);
      retentionUntil.setUTCFullYear(retentionUntil.getUTCFullYear() + 1);
      const result = await createAtsApplication(options.db, {
        submissionKey: fields.data.submissionKey,
        roleSlug,
        candidateName: fields.data.candidateName,
        candidateEmail: fields.data.candidateEmail,
        phone: fields.data.phone,
        location: fields.data.location,
        availability: fields.data.availability,
        links: linksParsed.data,
        answers: answersParsed.data,
        source: fields.data.source,
        consentAt: submittedAt.toISOString(),
        retentionUntil: retentionUntil.toISOString(),
        resume: {
          filename: safeFilename(resume.name),
          contentType: resume.type,
          bytes: resumeBytes,
        },
      }, submittedAt.toISOString());
      c.header('Cache-Control', 'no-store');
      return c.json({ receiptId: result.application.id }, result.created ? 201 : 200);
    } catch (err: unknown) {
      console.error('[ats] Application submission failed:', err instanceof Error ? err.message : String(err));
      return c.json({ error: 'Application could not be submitted' }, 503);
    }
  });

  app.get('/api/ats/booking/:token', async (c) => {
    const token = BookingTokenSchema.safeParse(c.req.param('token'));
    if (!token.success) return c.json({ error: 'Not found' }, 404);
    try {
      const tokenHash = createHash('sha256').update(token.data).digest('hex');
      const providerUrl = await resolveAtsBooking(options.db, tokenHash, now().toISOString());
      if (!providerUrl) return c.json({ error: 'Not found' }, 404);
      c.header('Cache-Control', 'no-store, private');
      return c.redirect(providerUrl, 302);
    } catch (err: unknown) {
      console.error('[ats] Booking link resolution failed:', err instanceof Error ? err.message : String(err));
      return c.json({ error: 'Booking unavailable' }, 503);
    }
  });

  app.use('/api/ats/admin/*', async (c, next) => {
    const authError = requireSecret(c, options.adminSecret, 'ATS administration');
    if (authError) return authError;
    c.header('Cache-Control', 'no-store, private');
    return next();
  });

  app.get('/api/ats/admin/applications', async (c) => {
    const query = z.object({
      roleSlug: z.string().trim().min(1).max(200).optional(),
      stage: z.enum(ATS_STAGES).optional(),
      disposition: z.enum(ATS_DISPOSITIONS).optional(),
      search: z.string().trim().min(1).max(200).optional(),
    }).safeParse(c.req.query());
    if (!query.success) return c.json({ error: 'Invalid filters' }, 422);
    try {
      return c.json({ applications: await listAtsApplications(options.db, query.data) });
    } catch (err: unknown) {
      console.error('[ats] Candidate list failed:', err instanceof Error ? err.message : String(err));
      return c.json({ error: 'Candidates unavailable' }, 503);
    }
  });

  app.get('/api/ats/admin/applications/:id', async (c) => {
    const id = z.uuid().safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: 'Invalid application' }, 422);
    try {
      const detail = await getAtsApplication(options.db, id.data);
      return detail ? c.json({ application: detail }) : c.json({ error: 'Not found' }, 404);
    } catch (err: unknown) {
      return adminRouteError(c, 'Candidate detail read', err);
    }
  });

  app.get('/api/ats/admin/applications/:id/resume', async (c) => {
    const id = z.uuid().safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: 'Invalid application' }, 422);
    try {
      const resume = await getAtsApplicationResume(options.db, id.data);
      if (!resume) return c.json({ error: 'Not found' }, 404);
      return new Response(resume.bytes as BodyInit, {
        headers: {
          'cache-control': 'no-store, private',
          'content-type': resume.contentType,
          'content-disposition': `attachment; filename="${safeFilename(resume.filename)}"`,
          'x-content-type-options': 'nosniff',
        },
      });
    } catch (err: unknown) {
      return adminRouteError(c, 'Candidate resume read', err);
    }
  });

  app.patch('/api/ats/admin/applications/:id', bodyLimit({ maxSize: ADMIN_BODY_LIMIT }), async (c) => {
    const id = z.uuid().safeParse(c.req.param('id'));
    const body = await readJson(c, MetadataSchema);
    if (!id.success || !body) return c.json({ error: 'Invalid candidate update' }, 422);
    try {
      const application = await updateAtsApplicationMetadata(options.db, {
        applicationId: id.data,
        ...body,
        actorId: getActorId(c.req.raw.headers),
        at: now().toISOString(),
      });
      return c.json({ application });
    } catch (err: unknown) {
      if (err instanceof AtsRevisionConflictError) return c.json({ error: 'Revision conflict' }, 409);
      return adminRouteError(c, 'Candidate metadata update', err);
    }
  });

  app.post('/api/ats/admin/applications/:id/transition', bodyLimit({ maxSize: ADMIN_BODY_LIMIT }), async (c) => {
    const id = z.uuid().safeParse(c.req.param('id'));
    const body = await readJson(c, TransitionSchema);
    if (!id.success || !body) return c.json({ error: 'Invalid transition' }, 422);
    try {
      const application = await transitionAtsApplication(options.db, {
        applicationId: id.data,
        ...body,
        actorId: getActorId(c.req.raw.headers),
        at: now().toISOString(),
      });
      return c.json({ application });
    } catch (err: unknown) {
      if (err instanceof AtsRevisionConflictError) return c.json({ error: 'Revision conflict' }, 409);
      if (err instanceof AtsApplicationNotFoundError) return c.json({ error: 'Not found' }, 404);
      console.error('[ats] Candidate transition failed:', err instanceof Error ? err.message : String(err));
      return c.json({ error: 'Transition failed' }, 503);
    }
  });

  app.post('/api/ats/admin/applications/:id/notes', bodyLimit({ maxSize: ADMIN_BODY_LIMIT }), async (c) => {
    const id = z.uuid().safeParse(c.req.param('id'));
    const body = await readJson(c, NoteSchema);
    if (!id.success || !body) return c.json({ error: 'Invalid note' }, 422);
    try {
      const note = await addAtsNote(options.db, {
        applicationId: id.data,
        authorId: getActorId(c.req.raw.headers),
        body: body.body,
        at: now().toISOString(),
      });
      return c.json({ note }, 201);
    } catch (err: unknown) {
      return adminRouteError(c, 'Candidate note create', err);
    }
  });

  app.put('/api/ats/admin/applications/:id/scorecards', bodyLimit({ maxSize: ADMIN_BODY_LIMIT }), async (c) => {
    const id = z.uuid().safeParse(c.req.param('id'));
    const body = await readJson(c, ScorecardSchema);
    if (!id.success || !body) return c.json({ error: 'Invalid scorecard' }, 422);
    try {
      const scorecard = await upsertAtsScorecard(options.db, {
        applicationId: id.data,
        interviewerId: getActorId(c.req.raw.headers),
        ...body,
        at: now().toISOString(),
      });
      return c.json({ scorecard });
    } catch (err: unknown) {
      return adminRouteError(c, 'Candidate scorecard update', err);
    }
  });

  app.post('/api/ats/admin/applications/:id/interviews', bodyLimit({ maxSize: ADMIN_BODY_LIMIT }), async (c) => {
    const id = z.uuid().safeParse(c.req.param('id'));
    const body = await readJson(c, InterviewSchema);
    if (!id.success || !body || !options.bookingBaseUrl) {
      return c.json({ error: options.bookingBaseUrl ? 'Invalid interview' : 'Booking not configured' }, options.bookingBaseUrl ? 422 : 503);
    }
    try {
      const token = randomBytes(32).toString('base64url');
      const bookingTokenHash = createHash('sha256').update(token).digest('hex');
      const providerUrl = new URL(options.bookingBaseUrl);
      providerUrl.searchParams.set('ats_interview', bookingTokenHash.slice(0, 16));
      const interview = await createAtsInterview(options.db, {
        applicationId: id.data,
        ...body,
        bookingTokenHash,
        bookingUrl: providerUrl.toString(),
        actorId: getActorId(c.req.raw.headers),
        at: now().toISOString(),
      });
      const siteUrl = options.publicSiteUrl ?? 'https://matrix-os.com';
      return c.json({
        interview,
        candidateBookingUrl: new URL(`/careers/schedule/${token}`, siteUrl).toString(),
      }, 201);
    } catch (err: unknown) {
      return adminRouteError(c, 'Candidate interview create', err);
    }
  });

  app.post('/api/ats/admin/applications/:id/tasks', bodyLimit({ maxSize: ADMIN_BODY_LIMIT }), async (c) => {
    const id = z.uuid().safeParse(c.req.param('id'));
    const body = await readJson(c, TaskSchema);
    if (!id.success || !body) return c.json({ error: 'Invalid task' }, 422);
    try {
      const task = await createAtsTask(options.db, {
        applicationId: id.data,
        ...body,
        actorId: getActorId(c.req.raw.headers),
        at: now().toISOString(),
      });
      return c.json({ task }, 201);
    } catch (err: unknown) {
      return adminRouteError(c, 'Candidate task create', err);
    }
  });

  app.post('/api/ats/admin/applications/:id/tasks/:taskId/complete', bodyLimit({ maxSize: ADMIN_BODY_LIMIT }), async (c) => {
    const ids = z.object({ applicationId: z.uuid(), taskId: z.uuid() }).safeParse({
      applicationId: c.req.param('id'),
      taskId: c.req.param('taskId'),
    });
    if (!ids.success) return c.json({ error: 'Invalid task' }, 422);
    try {
      const task = await completeAtsTask(options.db, {
        ...ids.data,
        actorId: getActorId(c.req.raw.headers),
        at: now().toISOString(),
      });
      return c.json({ task });
    } catch (err: unknown) {
      return adminRouteError(c, 'Candidate task complete', err);
    }
  });

  return app;
}
