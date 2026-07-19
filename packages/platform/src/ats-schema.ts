import { sql, type Kysely } from 'kysely';

export interface AtsApplicationsTable {
  id: string;
  submission_key: string;
  role_slug: string;
  candidate_name: string;
  candidate_email: string;
  phone: string | null;
  location: string;
  availability: string;
  links: string;
  answers: string;
  source: string;
  stage: string;
  disposition: string;
  revision: number;
  owner_id: string | null;
  tags: string;
  next_action_at: string | null;
  disposition_reason: string | null;
  consent_at: string;
  retention_until: string;
  resume_filename: string;
  resume_content_type: string;
  resume_bytes: Uint8Array;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface AtsApplicationEventsTable {
  id: string;
  application_id: string;
  event_type: string;
  actor_id: string | null;
  from_stage: string | null;
  to_stage: string | null;
  detail: string;
  created_at: string;
}

export interface AtsNotesTable {
  id: string;
  application_id: string;
  author_id: string;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface AtsScorecardsTable {
  id: string;
  application_id: string;
  interviewer_id: string;
  interview_type: string;
  recommendation: string;
  ratings: string;
  strengths: string;
  concerns: string | null;
  created_at: string;
  updated_at: string;
}

export interface AtsInterviewsTable {
  id: string;
  application_id: string;
  interview_type: string;
  status: string;
  interviewer_ids: string;
  booking_token_hash: string;
  booking_url: string;
  scheduled_start: string | null;
  scheduled_end: string | null;
  timezone: string | null;
  meeting_location: string | null;
  created_at: string;
  updated_at: string;
}

export interface AtsTasksTable {
  id: string;
  application_id: string;
  title: string;
  assignee_id: string | null;
  due_at: string | null;
  status: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AtsDatabaseTables {
  ats_applications: AtsApplicationsTable;
  ats_application_events: AtsApplicationEventsTable;
  ats_notes: AtsNotesTable;
  ats_scorecards: AtsScorecardsTable;
  ats_interviews: AtsInterviewsTable;
  ats_tasks: AtsTasksTable;
}

export async function migrateAts<T extends AtsDatabaseTables>(db: Kysely<T>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS ats_applications (
      id TEXT PRIMARY KEY,
      submission_key TEXT NOT NULL UNIQUE,
      role_slug TEXT NOT NULL,
      candidate_name TEXT NOT NULL,
      candidate_email TEXT NOT NULL,
      phone TEXT,
      location TEXT NOT NULL,
      availability TEXT NOT NULL,
      links TEXT NOT NULL DEFAULT '{}',
      answers TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'careers_page',
      stage TEXT NOT NULL DEFAULT 'applied',
      disposition TEXT NOT NULL DEFAULT 'active',
      revision INTEGER NOT NULL DEFAULT 1,
      owner_id TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      next_action_at TEXT,
      disposition_reason TEXT,
      consent_at TEXT NOT NULL,
      retention_until TEXT NOT NULL,
      resume_filename TEXT NOT NULL,
      resume_content_type TEXT NOT NULL,
      resume_bytes BYTEA NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_ats_applications_pipeline ON ats_applications(disposition, stage, updated_at DESC)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_ats_applications_role ON ats_applications(role_slug, updated_at DESC)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_ats_applications_email ON ats_applications(candidate_email)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_ats_applications_retention ON ats_applications(retention_until) WHERE deleted_at IS NULL`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS ats_application_events (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL REFERENCES ats_applications(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      actor_id TEXT,
      from_stage TEXT,
      to_stage TEXT,
      detail TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_ats_events_application ON ats_application_events(application_id, created_at DESC)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS ats_notes (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL REFERENCES ats_applications(id) ON DELETE CASCADE,
      author_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_ats_notes_application ON ats_notes(application_id, created_at DESC)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS ats_scorecards (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL REFERENCES ats_applications(id) ON DELETE CASCADE,
      interviewer_id TEXT NOT NULL,
      interview_type TEXT NOT NULL,
      recommendation TEXT NOT NULL,
      ratings TEXT NOT NULL DEFAULT '{}',
      strengths TEXT NOT NULL,
      concerns TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(application_id, interviewer_id, interview_type)
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_ats_scorecards_application ON ats_scorecards(application_id, updated_at DESC)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS ats_interviews (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL REFERENCES ats_applications(id) ON DELETE CASCADE,
      interview_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'awaiting_booking',
      interviewer_ids TEXT NOT NULL DEFAULT '[]',
      booking_token_hash TEXT NOT NULL UNIQUE,
      booking_url TEXT NOT NULL,
      scheduled_start TEXT,
      scheduled_end TEXT,
      timezone TEXT,
      meeting_location TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_ats_interviews_application ON ats_interviews(application_id, created_at DESC)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS ats_tasks (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL REFERENCES ats_applications(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      assignee_id TEXT,
      due_at TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_ats_tasks_application ON ats_tasks(application_id, status, due_at)`.execute(db);
}
