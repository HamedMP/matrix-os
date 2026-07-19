import { randomUUID } from 'node:crypto';
import type { AtsDB } from './ats-db.js';
import {
  applicationColumns,
  mapApplication,
  mapEvent,
  mapInterview,
  mapNote,
  mapScorecard,
  mapTask,
} from './ats-mappers.js';
import type {
  AtsApplicationDetail,
  AtsApplicationSummary,
  AtsDisposition,
  AtsEvent,
  AtsInterview,
  AtsNote,
  AtsScorecard,
  AtsStage,
  AtsTask,
} from './ats-types.js';

export class AtsRevisionConflictError extends Error {
  constructor() {
    super('Application was updated by another reviewer');
    this.name = 'AtsRevisionConflictError';
  }
}

export class AtsApplicationNotFoundError extends Error {
  constructor() {
    super('Application not found');
    this.name = 'AtsApplicationNotFoundError';
  }
}

async function insertEvent(
  db: AtsDB,
  input: {
    applicationId: string;
    eventType: string;
    actorId?: string | null;
    fromStage?: string | null;
    toStage?: string | null;
    detail?: Record<string, unknown>;
    at: string;
  },
): Promise<void> {
  await db.executor.insertInto('ats_application_events').values({
    id: randomUUID(),
    application_id: input.applicationId,
    event_type: input.eventType,
    actor_id: input.actorId ?? null,
    from_stage: input.fromStage ?? null,
    to_stage: input.toStage ?? null,
    detail: JSON.stringify(input.detail ?? {}),
    created_at: input.at,
  }).execute();
}

async function requireAtsApplication(db: AtsDB, applicationId: string): Promise<void> {
  const application = await db.executor.selectFrom('ats_applications')
    .select('id')
    .where('id', '=', applicationId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!application) throw new AtsApplicationNotFoundError();
}

export async function createAtsApplication(
  db: AtsDB,
  input: {
    submissionKey: string;
    roleSlug: string;
    candidateName: string;
    candidateEmail: string;
    phone: string | null;
    location: string;
    availability: string;
    links: Record<string, string>;
    answers: Array<{ prompt: string; answer: string }>;
    source: string;
    consentAt: string;
    retentionUntil: string;
    resume: { filename: string; contentType: string; bytes: Uint8Array };
  },
  now: string,
): Promise<{ application: AtsApplicationSummary; created: boolean }> {
  await db.ready;
  return db.transaction(async (trx) => {
    const id = randomUUID();
    const inserted = await trx.executor.insertInto('ats_applications').values({
      id,
      submission_key: input.submissionKey,
      role_slug: input.roleSlug,
      candidate_name: input.candidateName.trim(),
      candidate_email: input.candidateEmail.trim().toLowerCase(),
      phone: input.phone,
      location: input.location.trim(),
      availability: input.availability.trim(),
      links: JSON.stringify(input.links),
      answers: JSON.stringify(input.answers),
      source: input.source,
      stage: 'applied',
      disposition: 'active',
      revision: 1,
      owner_id: null,
      tags: '[]',
      next_action_at: null,
      disposition_reason: null,
      consent_at: input.consentAt,
      retention_until: input.retentionUntil,
      resume_filename: input.resume.filename,
      resume_content_type: input.resume.contentType,
      resume_bytes: input.resume.bytes,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    }).onConflict((oc) => oc.column('submission_key').doNothing())
      .returning(applicationColumns)
      .executeTakeFirst();

    if (!inserted) {
      const existing = await trx.executor.selectFrom('ats_applications')
        .select(applicationColumns)
        .where('submission_key', '=', input.submissionKey)
        .where('deleted_at', 'is', null)
        .executeTakeFirstOrThrow();
      return { application: mapApplication(existing), created: false };
    }

    await insertEvent(trx, {
      applicationId: id,
      eventType: 'application_submitted',
      detail: { roleSlug: input.roleSlug, source: input.source },
      at: now,
    });
    return { application: mapApplication(inserted), created: true };
  });
}

export async function listAtsApplications(
  db: AtsDB,
  filters: { roleSlug?: string; stage?: AtsStage; disposition?: AtsDisposition; search?: string },
): Promise<AtsApplicationSummary[]> {
  await db.ready;
  let query = db.executor.selectFrom('ats_applications')
    .select(applicationColumns)
    .where('deleted_at', 'is', null);
  if (filters.roleSlug) query = query.where('role_slug', '=', filters.roleSlug);
  if (filters.stage) query = query.where('stage', '=', filters.stage);
  if (filters.disposition) query = query.where('disposition', '=', filters.disposition);
  if (filters.search) {
    const search = `%${filters.search.trim().toLowerCase()}%`;
    query = query.where((eb) => eb.or([
      eb('candidate_email', 'like', search),
      eb(eb.fn<string>('lower', ['candidate_name']), 'like', search),
    ]));
  }
  return (await query.orderBy('updated_at', 'desc').limit(200).execute()).map(mapApplication);
}

export async function getAtsApplication(db: AtsDB, id: string): Promise<AtsApplicationDetail | undefined> {
  await db.ready;
  const application = await db.executor.selectFrom('ats_applications')
    .select(applicationColumns)
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!application) return undefined;
  const [events, notes, scorecards, interviews, tasks] = await Promise.all([
    db.executor.selectFrom('ats_application_events').selectAll().where('application_id', '=', id).orderBy('created_at', 'desc').execute(),
    db.executor.selectFrom('ats_notes').selectAll().where('application_id', '=', id).orderBy('created_at', 'desc').execute(),
    db.executor.selectFrom('ats_scorecards').selectAll().where('application_id', '=', id).orderBy('updated_at', 'desc').execute(),
    db.executor.selectFrom('ats_interviews').selectAll().where('application_id', '=', id).orderBy('created_at', 'desc').execute(),
    db.executor.selectFrom('ats_tasks').selectAll().where('application_id', '=', id).orderBy('created_at', 'desc').execute(),
  ]);
  return {
    ...mapApplication(application),
    events: events.map(mapEvent),
    notes: notes.map(mapNote),
    scorecards: scorecards.map(mapScorecard),
    interviews: interviews.map(mapInterview),
    tasks: tasks.map(mapTask),
  };
}

export async function getAtsApplicationResume(
  db: AtsDB,
  id: string,
): Promise<{ filename: string; contentType: string; bytes: Uint8Array } | undefined> {
  await db.ready;
  const row = await db.executor.selectFrom('ats_applications')
    .select(['resume_filename', 'resume_content_type', 'resume_bytes'])
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  return row ? {
    filename: row.resume_filename,
    contentType: row.resume_content_type,
    bytes: new Uint8Array(row.resume_bytes),
  } : undefined;
}

export async function transitionAtsApplication(
  db: AtsDB,
  input: {
    applicationId: string;
    baseRevision: number;
    stage: AtsStage;
    disposition: AtsDisposition;
    actorId: string;
    reason: string | null;
    at: string;
  },
): Promise<AtsApplicationSummary> {
  await db.ready;
  return db.transaction(async (trx) => {
    const before = await trx.executor.selectFrom('ats_applications')
      .select(['stage'])
      .where('id', '=', input.applicationId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!before) throw new AtsApplicationNotFoundError();
    const updated = await trx.executor.updateTable('ats_applications').set({
      stage: input.stage,
      disposition: input.disposition,
      disposition_reason: input.reason,
      revision: input.baseRevision + 1,
      updated_at: input.at,
    }).where('id', '=', input.applicationId)
      .where('revision', '=', input.baseRevision)
      .where('deleted_at', 'is', null)
      .returning(applicationColumns)
      .executeTakeFirst();
    if (!updated) throw new AtsRevisionConflictError();
    await insertEvent(trx, {
      applicationId: input.applicationId,
      eventType: input.disposition === 'active' ? 'stage_changed' : 'disposition_changed',
      actorId: input.actorId,
      fromStage: before.stage,
      toStage: input.stage,
      detail: { disposition: input.disposition, reason: input.reason },
      at: input.at,
    });
    return mapApplication(updated);
  });
}

export async function updateAtsApplicationMetadata(
  db: AtsDB,
  input: {
    applicationId: string;
    baseRevision: number;
    ownerId: string | null;
    tags: string[];
    nextActionAt: string | null;
    actorId: string;
    at: string;
  },
): Promise<AtsApplicationSummary> {
  await db.ready;
  return db.transaction(async (trx) => {
    await requireAtsApplication(trx, input.applicationId);
    const updated = await trx.executor.updateTable('ats_applications').set({
      owner_id: input.ownerId,
      tags: JSON.stringify(input.tags),
      next_action_at: input.nextActionAt,
      revision: input.baseRevision + 1,
      updated_at: input.at,
    }).where('id', '=', input.applicationId)
      .where('revision', '=', input.baseRevision)
      .where('deleted_at', 'is', null)
      .returning(applicationColumns)
      .executeTakeFirst();
    if (!updated) throw new AtsRevisionConflictError();
    await insertEvent(trx, {
      applicationId: input.applicationId,
      eventType: 'application_metadata_updated',
      actorId: input.actorId,
      detail: { ownerId: input.ownerId, tags: input.tags, nextActionAt: input.nextActionAt },
      at: input.at,
    });
    return mapApplication(updated);
  });
}

export async function addAtsNote(db: AtsDB, input: {
  applicationId: string; authorId: string; body: string; at: string;
}): Promise<AtsNote> {
  await db.ready;
  return db.transaction(async (trx) => {
    await requireAtsApplication(trx, input.applicationId);
    const row = await trx.executor.insertInto('ats_notes').values({
      id: randomUUID(), application_id: input.applicationId, author_id: input.authorId,
      body: input.body, created_at: input.at, updated_at: input.at,
    }).returningAll().executeTakeFirstOrThrow();
    await insertEvent(trx, { applicationId: input.applicationId, eventType: 'note_added', actorId: input.authorId, at: input.at });
    return mapNote(row);
  });
}

export async function upsertAtsScorecard(db: AtsDB, input: {
  applicationId: string; interviewerId: string; interviewType: string;
  recommendation: string; ratings: Record<string, number>; strengths: string;
  concerns: string | null; at: string;
}): Promise<AtsScorecard> {
  await db.ready;
  return db.transaction(async (trx) => {
    await requireAtsApplication(trx, input.applicationId);
    const id = randomUUID();
    const row = await trx.executor.insertInto('ats_scorecards').values({
      id, application_id: input.applicationId, interviewer_id: input.interviewerId,
      interview_type: input.interviewType, recommendation: input.recommendation,
      ratings: JSON.stringify(input.ratings), strengths: input.strengths,
      concerns: input.concerns, created_at: input.at, updated_at: input.at,
    }).onConflict((oc) => oc.columns(['application_id', 'interviewer_id', 'interview_type']).doUpdateSet({
      recommendation: input.recommendation,
      ratings: JSON.stringify(input.ratings),
      strengths: input.strengths,
      concerns: input.concerns,
      updated_at: input.at,
    })).returningAll().executeTakeFirstOrThrow();
    await insertEvent(trx, { applicationId: input.applicationId, eventType: 'scorecard_submitted', actorId: input.interviewerId, detail: { interviewType: input.interviewType }, at: input.at });
    return mapScorecard(row);
  });
}

export async function createAtsInterview(db: AtsDB, input: {
  applicationId: string; interviewType: string; interviewerIds: string[];
  bookingTokenHash: string; bookingUrl: string; actorId: string; at: string;
}): Promise<AtsInterview> {
  await db.ready;
  return db.transaction(async (trx) => {
    await requireAtsApplication(trx, input.applicationId);
    const row = await trx.executor.insertInto('ats_interviews').values({
      id: randomUUID(), application_id: input.applicationId,
      interview_type: input.interviewType, status: 'awaiting_booking',
      interviewer_ids: JSON.stringify(input.interviewerIds),
      booking_token_hash: input.bookingTokenHash, booking_url: input.bookingUrl,
      scheduled_start: null, scheduled_end: null, timezone: null,
      meeting_location: null, created_at: input.at, updated_at: input.at,
    }).returningAll().executeTakeFirstOrThrow();
    await insertEvent(trx, { applicationId: input.applicationId, eventType: 'interview_created', actorId: input.actorId, detail: { interviewType: input.interviewType }, at: input.at });
    return mapInterview(row);
  });
}

export async function resolveAtsBooking(
  db: AtsDB,
  bookingTokenHash: string,
  at: string,
): Promise<string | undefined> {
  await db.ready;
  return db.transaction(async (trx) => {
    const interview = await trx.executor.selectFrom('ats_interviews')
      .select(['id', 'application_id', 'status', 'booking_url'])
      .where('booking_token_hash', '=', bookingTokenHash)
      .executeTakeFirst();
    if (!interview) return undefined;
    if (interview.status === 'awaiting_booking') {
      const updated = await trx.executor.updateTable('ats_interviews').set({
        status: 'booking_opened',
        updated_at: at,
      }).where('id', '=', interview.id)
        .where('status', '=', 'awaiting_booking')
        .returning('id')
        .executeTakeFirst();
      if (updated) {
        await insertEvent(trx, {
          applicationId: interview.application_id,
          eventType: 'booking_link_opened',
          detail: { interviewId: interview.id },
          at,
        });
      }
    }
    return interview.booking_url;
  });
}

export async function createAtsTask(db: AtsDB, input: {
  applicationId: string; title: string; assigneeId: string | null;
  dueAt: string | null; actorId: string; at: string;
}): Promise<AtsTask> {
  await db.ready;
  return db.transaction(async (trx) => {
    await requireAtsApplication(trx, input.applicationId);
    const row = await trx.executor.insertInto('ats_tasks').values({
      id: randomUUID(), application_id: input.applicationId, title: input.title,
      assignee_id: input.assigneeId, due_at: input.dueAt, status: 'open',
      completed_at: null, created_at: input.at, updated_at: input.at,
    }).returningAll().executeTakeFirstOrThrow();
    await insertEvent(trx, { applicationId: input.applicationId, eventType: 'task_created', actorId: input.actorId, detail: { taskId: row.id }, at: input.at });
    return mapTask(row);
  });
}

export async function completeAtsTask(db: AtsDB, input: {
  applicationId: string; taskId: string; actorId: string; at: string;
}): Promise<AtsTask> {
  await db.ready;
  return db.transaction(async (trx) => {
    const row = await trx.executor.updateTable('ats_tasks').set({
      status: 'completed', completed_at: input.at, updated_at: input.at,
    }).where('id', '=', input.taskId)
      .where('application_id', '=', input.applicationId)
      .where('status', '=', 'open')
      .returningAll().executeTakeFirst();
    if (!row) throw new AtsApplicationNotFoundError();
    await insertEvent(trx, { applicationId: input.applicationId, eventType: 'task_completed', actorId: input.actorId, detail: { taskId: input.taskId }, at: input.at });
    return mapTask(row);
  });
}
