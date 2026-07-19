import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
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
} from '../../packages/platform/src/ats-repository.js';
import type { AtsDB } from '../../packages/platform/src/ats-db.js';
import { createTestAtsDb, destroyTestAtsDb } from './ats-db-test-helper.js';

const NOW = '2026-07-19T12:00:00.000Z';

function applicationInput(overrides: Record<string, unknown> = {}) {
  return {
    submissionKey: '550e8400-e29b-41d4-a716-446655440000',
    roleSlug: 'founding-engineer',
    candidateName: 'Ada Lovelace',
    candidateEmail: 'ADA@example.com',
    phone: null,
    location: 'London, UK',
    availability: 'One month',
    links: {
      linkedin: 'https://www.linkedin.com/in/ada',
      github: 'https://github.com/ada',
    },
    answers: [
      { prompt: 'Why Matrix?', answer: 'Persistent computers for agents are inevitable.' },
      { prompt: 'Hardest system?', answer: 'A distributed analytical engine.' },
    ],
    source: 'careers_page',
    consentAt: NOW,
    retentionUntil: '2027-07-19T12:00:00.000Z',
    resume: {
      filename: 'ada-resume.pdf',
      contentType: 'application/pdf',
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    },
    ...overrides,
  };
}

describe('platform ATS repository', () => {
  let db: AtsDB;

  beforeEach(async () => {
    ({ db } = await createTestAtsDb());
  });

  afterEach(async () => {
    await destroyTestAtsDb(db);
  });

  it('creates an application and submission event atomically', async () => {
    const result = await createAtsApplication(db, applicationInput(), NOW);

    expect(result.created).toBe(true);
    expect(result.application).toMatchObject({
      candidateName: 'Ada Lovelace',
      candidateEmail: 'ada@example.com',
      roleSlug: 'founding-engineer',
      stage: 'applied',
      disposition: 'active',
      revision: 1,
    });

    const detail = await getAtsApplication(db, result.application.id);
    expect(detail?.events).toHaveLength(1);
    expect(detail?.events[0]?.eventType).toBe('application_submitted');
  });

  it('is idempotent by submission key without duplicating events', async () => {
    const first = await createAtsApplication(db, applicationInput(), NOW);
    const second = await createAtsApplication(db, applicationInput(), NOW);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.application.id).toBe(first.application.id);
    expect((await getAtsApplication(db, first.application.id))?.events).toHaveLength(1);
  });

  it('keeps resume bytes out of list and detail reads', async () => {
    const { application } = await createAtsApplication(db, applicationInput(), NOW);

    const [summary] = await listAtsApplications(db, {});
    const detail = await getAtsApplication(db, application.id);
    expect(summary).not.toHaveProperty('resumeBytes');
    expect(detail).not.toHaveProperty('resumeBytes');

    const resume = await getAtsApplicationResume(db, application.id);
    expect(resume?.filename).toBe('ada-resume.pdf');
    expect([...resume!.bytes]).toEqual([0x25, 0x50, 0x44, 0x46]);
  });

  it('enforces optimistic concurrency in the stage update and records one event', async () => {
    const { application } = await createAtsApplication(db, applicationInput(), NOW);

    const updated = await transitionAtsApplication(db, {
      applicationId: application.id,
      baseRevision: 1,
      stage: 'screening',
      disposition: 'active',
      actorId: 'user_founder',
      reason: null,
      at: '2026-07-19T13:00:00.000Z',
    });
    expect(updated).toMatchObject({ stage: 'screening', revision: 2 });

    await expect(transitionAtsApplication(db, {
      applicationId: application.id,
      baseRevision: 1,
      stage: 'intro_call',
      disposition: 'active',
      actorId: 'user_founder',
      reason: null,
      at: '2026-07-19T14:00:00.000Z',
    })).rejects.toBeInstanceOf(AtsRevisionConflictError);

    const detail = await getAtsApplication(db, application.id);
    expect(detail?.events.map((event) => event.eventType)).toEqual([
      'stage_changed',
      'application_submitted',
    ]);
  });

  it('updates CRM ownership, tags, and next action with optimistic concurrency', async () => {
    const { application } = await createAtsApplication(db, applicationInput(), NOW);

    const updated = await updateAtsApplicationMetadata(db, {
      applicationId: application.id,
      baseRevision: 1,
      ownerId: 'user_founder',
      tags: ['systems', 'high-priority'],
      nextActionAt: '2026-07-21T09:00:00.000Z',
      actorId: 'user_founder',
      at: '2026-07-19T13:00:00.000Z',
    });

    expect(updated).toMatchObject({
      ownerId: 'user_founder',
      tags: ['systems', 'high-priority'],
      nextActionAt: '2026-07-21T09:00:00.000Z',
      revision: 2,
    });
    await expect(updateAtsApplicationMetadata(db, {
      applicationId: application.id,
      baseRevision: 1,
      ownerId: null,
      tags: [],
      nextActionAt: null,
      actorId: 'user_founder',
      at: NOW,
    })).rejects.toBeInstanceOf(AtsRevisionConflictError);
    expect((await getAtsApplication(db, application.id))?.events[0]?.eventType).toBe('application_metadata_updated');
  });

  it('resolves a candidate booking token and records its first use once', async () => {
    const { application } = await createAtsApplication(db, applicationInput(), NOW);
    await createAtsInterview(db, {
      applicationId: application.id,
      interviewType: 'intro_call',
      interviewerIds: ['user_founder'],
      bookingTokenHash: 'b'.repeat(64),
      bookingUrl: 'https://cal.com/matrix/intro',
      actorId: 'user_founder',
      at: NOW,
    });

    expect(await resolveAtsBooking(db, 'b'.repeat(64), '2026-07-19T13:00:00.000Z')).toBe('https://cal.com/matrix/intro');
    expect(await resolveAtsBooking(db, 'b'.repeat(64), '2026-07-19T14:00:00.000Z')).toBe('https://cal.com/matrix/intro');
    expect(await resolveAtsBooking(db, 'c'.repeat(64), NOW)).toBeUndefined();

    const detail = await getAtsApplication(db, application.id);
    expect(detail?.interviews[0]?.status).toBe('booking_opened');
    expect(detail?.events.filter((event) => event.eventType === 'booking_link_opened')).toHaveLength(1);
  });

  it('persists notes, scorecards, interviews, and tasks in candidate detail', async () => {
    const { application } = await createAtsApplication(db, applicationInput(), NOW);
    await addAtsNote(db, {
      applicationId: application.id,
      authorId: 'user_founder',
      body: 'Strong systems judgment.',
      at: NOW,
    });
    await upsertAtsScorecard(db, {
      applicationId: application.id,
      interviewerId: 'user_founder',
      interviewType: 'technical_interview',
      recommendation: 'strong_yes',
      ratings: { systems: 5, product: 4, collaboration: 5 },
      strengths: 'Excellent architecture and debugging depth.',
      concerns: null,
      at: NOW,
    });
    const interview = await createAtsInterview(db, {
      applicationId: application.id,
      interviewType: 'intro_call',
      interviewerIds: ['user_founder'],
      bookingTokenHash: 'a'.repeat(64),
      bookingUrl: 'https://cal.com/matrix/intro',
      actorId: 'user_founder',
      at: NOW,
    });
    expect(interview.status).toBe('awaiting_booking');
    const task = await createAtsTask(db, {
      applicationId: application.id,
      title: 'Review GitHub projects',
      assigneeId: 'user_founder',
      dueAt: '2026-07-20T12:00:00.000Z',
      actorId: 'user_founder',
      at: NOW,
    });
    await completeAtsTask(db, {
      applicationId: application.id,
      taskId: task.id,
      actorId: 'user_founder',
      at: '2026-07-20T10:00:00.000Z',
    });

    const detail = await getAtsApplication(db, application.id);
    expect(detail?.notes[0]?.body).toBe('Strong systems judgment.');
    expect(detail?.scorecards[0]?.recommendation).toBe('strong_yes');
    expect(detail?.interviews[0]?.bookingUrl).toBe('https://cal.com/matrix/intro');
    expect(detail?.tasks[0]?.status).toBe('completed');
    expect(detail?.events.map((event) => event.eventType)).toEqual(expect.arrayContaining([
      'task_completed',
      'task_created',
      'interview_created',
      'scorecard_submitted',
      'note_added',
      'application_submitted',
    ]));
  });
});
