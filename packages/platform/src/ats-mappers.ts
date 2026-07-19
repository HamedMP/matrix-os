import type { Selectable } from 'kysely';
import type {
  AtsApplicationEventsTable,
  AtsApplicationsTable,
  AtsInterviewsTable,
  AtsNotesTable,
  AtsScorecardsTable,
  AtsTasksTable,
} from './ats-schema.js';
import type {
  AtsApplicationSummary,
  AtsDisposition,
  AtsEvent,
  AtsInterview,
  AtsNote,
  AtsScorecard,
  AtsStage,
  AtsTask,
} from './ats-types.js';

export const applicationColumns = [
  'id', 'submission_key', 'role_slug', 'candidate_name', 'candidate_email',
  'phone', 'location', 'availability', 'links', 'answers', 'source', 'stage',
  'disposition', 'revision', 'owner_id', 'tags', 'next_action_at',
  'disposition_reason', 'consent_at', 'retention_until', 'resume_filename',
  'resume_content_type', 'created_at', 'updated_at',
] as const;

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

export function mapApplication(row: Omit<Selectable<AtsApplicationsTable>, 'resume_bytes' | 'deleted_at'>): AtsApplicationSummary {
  return {
    id: row.id,
    submissionKey: row.submission_key,
    roleSlug: row.role_slug,
    candidateName: row.candidate_name,
    candidateEmail: row.candidate_email,
    phone: row.phone,
    location: row.location,
    availability: row.availability,
    links: parseJson<Record<string, string>>(row.links),
    answers: parseJson<Array<{ prompt: string; answer: string }>>(row.answers),
    source: row.source,
    stage: row.stage as AtsStage,
    disposition: row.disposition as AtsDisposition,
    revision: row.revision,
    ownerId: row.owner_id,
    tags: parseJson<string[]>(row.tags),
    nextActionAt: row.next_action_at,
    dispositionReason: row.disposition_reason,
    consentAt: row.consent_at,
    retentionUntil: row.retention_until,
    resumeFilename: row.resume_filename,
    resumeContentType: row.resume_content_type,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapEvent(row: Selectable<AtsApplicationEventsTable>): AtsEvent {
  return { id: row.id, applicationId: row.application_id, eventType: row.event_type, actorId: row.actor_id, fromStage: row.from_stage, toStage: row.to_stage, detail: parseJson<Record<string, unknown>>(row.detail), createdAt: row.created_at };
}

export function mapNote(row: Selectable<AtsNotesTable>): AtsNote {
  return { id: row.id, applicationId: row.application_id, authorId: row.author_id, body: row.body, createdAt: row.created_at, updatedAt: row.updated_at };
}

export function mapScorecard(row: Selectable<AtsScorecardsTable>): AtsScorecard {
  return { id: row.id, applicationId: row.application_id, interviewerId: row.interviewer_id, interviewType: row.interview_type, recommendation: row.recommendation, ratings: parseJson<Record<string, number>>(row.ratings), strengths: row.strengths, concerns: row.concerns, createdAt: row.created_at, updatedAt: row.updated_at };
}

export function mapInterview(row: Selectable<AtsInterviewsTable>): AtsInterview {
  return { id: row.id, applicationId: row.application_id, interviewType: row.interview_type, status: row.status, interviewerIds: parseJson<string[]>(row.interviewer_ids), bookingUrl: row.booking_url, scheduledStart: row.scheduled_start, scheduledEnd: row.scheduled_end, timezone: row.timezone, meetingLocation: row.meeting_location, createdAt: row.created_at, updatedAt: row.updated_at };
}

export function mapTask(row: Selectable<AtsTasksTable>): AtsTask {
  return { id: row.id, applicationId: row.application_id, title: row.title, assigneeId: row.assignee_id, dueAt: row.due_at, status: row.status, completedAt: row.completed_at, createdAt: row.created_at, updatedAt: row.updated_at };
}
