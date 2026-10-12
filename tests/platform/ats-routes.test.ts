import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAtsRoutes } from '../../packages/platform/src/ats-routes.js';
import type { AtsDB } from '../../packages/platform/src/ats-db.js';
import { createTestAtsDb, destroyTestAtsDb } from './ats-db-test-helper.js';

const INGEST_SECRET = 'test-ingest-secret';
const ADMIN_SECRET = 'test-admin-secret';

function validApplicationForm() {
  const form = new FormData();
  form.set('submissionKey', '550e8400-e29b-41d4-a716-446655440000');
  form.set('roleSlug', 'founding-engineer');
  form.set('candidateName', 'Ada Lovelace');
  form.set('candidateEmail', 'ada@example.com');
  form.set('location', 'London, UK');
  form.set('availability', 'One month');
  form.set('links', JSON.stringify({ github: 'https://github.com/ada' }));
  form.set('answers', JSON.stringify([{ prompt: 'Why Matrix?', answer: 'Agents need computers.' }]));
  form.set('source', 'careers_page');
  form.set('consent', 'true');
  form.set('resume', new File(['%PDF'], 'ada.pdf', { type: 'application/pdf' }));
  return form;
}

describe('platform ATS routes', () => {
  let db: AtsDB;

  beforeEach(async () => {
    ({ db } = await createTestAtsDb());
  });

  afterEach(async () => {
    await destroyTestAtsDb(db);
  });

  function routes(overrides: Partial<Parameters<typeof createAtsRoutes>[0]> = {}) {
    return createAtsRoutes({
      db,
      ingestSecret: INGEST_SECRET,
      adminSecret: ADMIN_SECRET,
      allowedRoleSlugs: ['founders-associate-gtm-operations', 'founding-engineer'],
      bookingBaseUrl: 'https://cal.com/matrix',
      now: () => new Date('2026-07-19T12:00:00.000Z'),
      ...overrides,
    });
  }

  it('fails closed when application ingest is not configured', async () => {
    const res = await routes({ ingestSecret: '' }).request('/api/ats/applications', {
      method: 'POST',
      body: validApplicationForm(),
    });
    expect(res.status).toBe(503);
  });

  it('rejects an unauthenticated application submission', async () => {
    const res = await routes().request('/api/ats/applications', {
      method: 'POST',
      body: validApplicationForm(),
    });
    expect(res.status).toBe(401);
  });

  it('accepts a valid application and returns an opaque receipt', async () => {
    const res = await routes().request('/api/ats/applications', {
      method: 'POST',
      headers: { authorization: `Bearer ${INGEST_SECRET}` },
      body: validApplicationForm(),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { receiptId: string };
    expect(body.receiptId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects invalid roles, missing consent, and unsafe resume types', async () => {
    const invalid = validApplicationForm();
    invalid.set('roleSlug', 'chief-vibes-officer');
    invalid.set('consent', 'false');
    invalid.set('resume', new File(['hello'], 'resume.html', { type: 'text/html' }));
    const res = await routes().request('/api/ats/applications', {
      method: 'POST',
      headers: { authorization: `Bearer ${INGEST_SECRET}` },
      body: invalid,
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'Invalid application' });
  });

  it('returns a validation error for malformed application JSON fields', async () => {
    const invalid = validApplicationForm();
    invalid.set('links', '{not-json');
    const res = await routes().request('/api/ats/applications', {
      method: 'POST',
      headers: { authorization: `Bearer ${INGEST_SECRET}` },
      body: invalid,
    });

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'Invalid application' });
  });

  it('keeps candidate lists and CV downloads behind the admin secret', async () => {
    const submitted = await routes().request('/api/ats/applications', {
      method: 'POST',
      headers: { authorization: `Bearer ${INGEST_SECRET}` },
      body: validApplicationForm(),
    });
    const { receiptId } = await submitted.json() as { receiptId: string };

    expect((await routes().request('/api/ats/admin/applications')).status).toBe(401);
    const list = await routes().request('/api/ats/admin/applications', {
      headers: { authorization: `Bearer ${ADMIN_SECRET}` },
    });
    expect(list.status).toBe(200);
    const listBody = await list.json() as { applications: Array<Record<string, unknown>> };
    expect(listBody.applications).toHaveLength(1);
    expect(listBody.applications[0]).not.toHaveProperty('resumeBytes');

    const cv = await routes().request(`/api/ats/admin/applications/${receiptId}/resume`, {
      headers: { authorization: `Bearer ${ADMIN_SECRET}` },
    });
    expect(cv.status).toBe(200);
    expect(cv.headers.get('content-type')).toBe('application/pdf');
    expect(cv.headers.get('content-disposition')).toContain('attachment;');
    expect(await cv.text()).toBe('%PDF');
  });

  it('updates candidate CRM metadata behind admin auth', async () => {
    const submitted = await routes().request('/api/ats/applications', {
      method: 'POST', headers: { authorization: `Bearer ${INGEST_SECRET}` }, body: validApplicationForm(),
    });
    const { receiptId } = await submitted.json() as { receiptId: string };
    const response = await routes().request(`/api/ats/admin/applications/${receiptId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${ADMIN_SECRET}`, 'content-type': 'application/json', 'x-ats-actor-id': 'user_founder' },
      body: JSON.stringify({
        baseRevision: 1,
        ownerId: 'user_founder',
        tags: ['systems', 'high-priority'],
        nextActionAt: '2026-07-21T09:00:00.000Z',
      }),
    });
    expect(response.status).toBe(200);
    expect((await response.json() as { application: Record<string, unknown> }).application).toMatchObject({
      ownerId: 'user_founder', tags: ['systems', 'high-priority'], revision: 2,
    });
  });

  it('reassigns a candidate role and filters by the new position with an attributed history', async () => {
    const app = routes();
    const submitted = await app.request('/api/ats/applications', {
      method: 'POST', headers: { authorization: `Bearer ${INGEST_SECRET}` }, body: validApplicationForm(),
    });
    const { receiptId } = await submitted.json() as { receiptId: string };
    const headers = { authorization: `Bearer ${ADMIN_SECRET}`, 'content-type': 'application/json', 'x-ats-actor-id': 'user_reviewer' };
    const payload = { baseRevision: 1, roleSlug: 'founders-associate-gtm-operations', ownerId: null, tags: [], nextActionAt: null };
    expect((await app.request(`/api/ats/admin/applications/${receiptId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    })).status).toBe(401);
    const updated = await app.request(`/api/ats/admin/applications/${receiptId}`, {
      method: 'PATCH', headers, body: JSON.stringify(payload),
    });
    expect(updated.status).toBe(200);
    expect((await updated.json() as { application: Record<string, unknown> }).application).toMatchObject({
      roleSlug: payload.roleSlug, revision: 2,
    });
    for (const [roleSlug, count] of [['founding-engineer', 0], [payload.roleSlug, 1]] as const) {
      const list = await app.request(`/api/ats/admin/applications?roleSlug=${roleSlug}`, { headers });
      expect((await list.json() as { applications: unknown[] }).applications).toHaveLength(count);
    }
    const stale = await app.request(`/api/ats/admin/applications/${receiptId}`, {
      method: 'PATCH', headers, body: JSON.stringify({ ...payload, roleSlug: 'founding-engineer' }),
    });
    expect(stale.status).toBe(409);
    const detail = await app.request(`/api/ats/admin/applications/${receiptId}`, { headers });
    const { application } = await detail.json() as { application: { events: Array<Record<string, unknown>> } };
    expect(application.events.filter(event => event.eventType === 'application_metadata_updated')).toEqual([
      expect.objectContaining({ actorId: 'user_reviewer', detail: expect.objectContaining({ roleSlug: payload.roleSlug }) }),
    ]);
  });

  it('rejects unknown role assignments without changing candidate data', async () => {
    const app = routes();
    const submitted = await app.request('/api/ats/applications', {
      method: 'POST', headers: { authorization: `Bearer ${INGEST_SECRET}` }, body: validApplicationForm(),
    });
    const { receiptId } = await submitted.json() as { receiptId: string };
    const headers = { authorization: `Bearer ${ADMIN_SECRET}`, 'content-type': 'application/json' };
    const response = await app.request(`/api/ats/admin/applications/${receiptId}`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ baseRevision: 1, roleSlug: 'not-a-position', ownerId: null, tags: [], nextActionAt: null }),
    });
    expect(response.status).toBe(422);
    const detail = await app.request(`/api/ats/admin/applications/${receiptId}`, { headers });
    expect((await detail.json() as { application: Record<string, unknown> }).application).toMatchObject({ roleSlug: 'founding-engineer', revision: 1 });
  });

  it('preserves closed positions when updating metadata without a role assignment', async () => {
    const form = validApplicationForm();
    form.set('roleSlug', 'closed-engineer');
    const submitted = await routes({ allowedRoleSlugs: ['closed-engineer'] }).request('/api/ats/applications', {
      method: 'POST', headers: { authorization: `Bearer ${INGEST_SECRET}` }, body: form,
    });
    const { receiptId } = await submitted.json() as { receiptId: string };
    const response = await routes().request(`/api/ats/admin/applications/${receiptId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${ADMIN_SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify({ baseRevision: 1, ownerId: 'user_reviewer', tags: ['reviewed'], nextActionAt: null }),
    });
    expect(response.status).toBe(200);
    expect((await response.json() as { application: Record<string, unknown> }).application).toMatchObject({
      roleSlug: 'closed-engineer', revision: 2, ownerId: 'user_reviewer', tags: ['reviewed'],
    });
  });

  it('returns controlled not-found responses for missing admin mutation targets', async () => {
    const missingApplicationId = '550e8400-e29b-41d4-a716-446655440099';
    const missingTaskId = '550e8400-e29b-41d4-a716-446655440098';
    const headers = {
      authorization: `Bearer ${ADMIN_SECRET}`,
      'content-type': 'application/json',
    };
    const requests = [
      routes().request(`/api/ats/admin/applications/${missingApplicationId}`, {
        method: 'PATCH', headers, body: JSON.stringify({ baseRevision: 1, ownerId: null, tags: [], nextActionAt: null }),
      }),
      routes().request(`/api/ats/admin/applications/${missingApplicationId}/notes`, {
        method: 'POST', headers, body: JSON.stringify({ body: 'Review note' }),
      }),
      routes().request(`/api/ats/admin/applications/${missingApplicationId}/scorecards`, {
        method: 'PUT', headers, body: JSON.stringify({
          interviewType: 'technical', recommendation: 'yes', ratings: { systems: 5 }, strengths: 'Strong', concerns: null,
        }),
      }),
      routes().request(`/api/ats/admin/applications/${missingApplicationId}/interviews`, {
        method: 'POST', headers, body: JSON.stringify({ interviewType: 'intro', interviewerIds: ['user_founder'] }),
      }),
      routes().request(`/api/ats/admin/applications/${missingApplicationId}/tasks`, {
        method: 'POST', headers, body: JSON.stringify({ title: 'Review', assigneeId: null, dueAt: null }),
      }),
      routes().request(`/api/ats/admin/applications/${missingApplicationId}/tasks/${missingTaskId}/complete`, {
        method: 'POST', headers,
      }),
    ];

    for (const response of await Promise.all(requests)) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Not found' });
    }
  });

  it('redirects a valid candidate booking token without exposing the provider URL in ATS records', async () => {
    const submitted = await routes().request('/api/ats/applications', {
      method: 'POST', headers: { authorization: `Bearer ${INGEST_SECRET}` }, body: validApplicationForm(),
    });
    const { receiptId } = await submitted.json() as { receiptId: string };
    const created = await routes({ publicSiteUrl: 'https://matrix-os.com' }).request(`/api/ats/admin/applications/${receiptId}/interviews`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify({ interviewType: 'intro_call', interviewerIds: ['user_founder'] }),
    });
    const body = await created.json() as { candidateBookingUrl: string };
    const token = new URL(body.candidateBookingUrl).pathname.split('/').at(-1)!;

    const booking = await routes().request(`/api/ats/booking/${token}`);
    expect(booking.status).toBe(302);
    expect(booking.headers.get('location')).toMatch(/^https:\/\/cal\.com\/matrix/);
    expect((await routes().request('/api/ats/booking/not-a-token')).status).toBe(404);
  });
});
