# Spec 108: Recruiting ATS

## Status

Draft for implementation.

## Problem

Matrix needs a first-party applicant tracking system tied to the careers pages. Applicants should apply without creating a Matrix account, while the founding team needs a secure CRM-like workflow for screening, reviewing CVs, coordinating interviews, recording decisions, and preserving an auditable hiring history.

Email-only applications lose structured answers, duplicate follow-ups, stage history, review context, and retention controls. A generic third-party ATS would also fragment candidate data from Matrix's existing PostgreSQL platform.

## Goals

- Replace `mailto:` application links with a structured, accessible application flow.
- Store recruiting records in the existing platform PostgreSQL database.
- Keep CV files private, bounded, and available only to authorized hiring administrators.
- Provide a hiring pipeline with explicit stages, optimistic concurrency, search, filters, assignments, tags, next actions, notes, tasks, scorecards, and activity history.
- Support interview planning and candidate-specific booking links without coupling the data model to one calendar provider.
- Give applicants clear consent, submission confirmation, and safe duplicate behavior.
- Support retention, withdrawal, rejection, archival, export, and deletion workflows.

## Non-goals for the first release

- Payroll, offer-letter signature, background checks, or HRIS onboarding.
- Automated employment decisions or opaque AI ranking.
- Scraping candidates from external networks.
- Storing CVs in a public bucket or exposing platform administration credentials to browsers.

## Architecture

```text
Applicant browser
  -> matrix-os-site /api/careers/apply
  -> platform /api/ats/applications (ATS_INGEST_SECRET)
  -> dedicated recruiting PostgreSQL (`ATS_DATABASE_URL`)

Hiring admin browser
  -> Clerk-protected matrix-os-site /admin/ats
  -> site server actions (ATS_ADMIN_SECRET)
  -> platform /api/ats/admin/*
  -> dedicated recruiting PostgreSQL (`ATS_DATABASE_URL`)
```

The public browser never receives either platform secret. The site validates and forwards multipart applications server-side. Platform routes independently validate every field and file. Recruiting uses a dedicated PostgreSQL/Neon database and never migrates ATS tables into `PLATFORM_DATABASE_URL`.

## Roles and authorization

- **Applicant:** anonymous; can submit an application and later use a high-entropy candidate link for explicitly exposed actions such as booking or withdrawal.
- **Hiring admin:** authenticated through Clerk and allowlisted by the site (`publicMetadata.role === "admin"` for the first release). All admin platform requests are server-to-server.
- **Platform service:** validates a scoped ingest secret for submissions and a separate admin secret for recruiting operations.

## Pipeline

Canonical stages:

1. `applied`
2. `screening`
3. `intro_call`
4. `technical_interview`
5. `founder_interview`
6. `reference_check`
7. `offer`
8. `hired`

Terminal/disposition states are represented separately: `active`, `rejected`, `withdrawn`, `archived`, and `deleted`. Stage changes require `baseRevision`; the `UPDATE` enforces the revision in its `WHERE` clause and increments it atomically. Every successful transition writes an activity event in the same transaction.

## Data model

- `ats_applications`: candidate identity, role, structured answers, links, source, stage, disposition, owner, tags, next action, consent, retention date, revision, timestamps, and bounded CV bytes/metadata.
- `ats_application_events`: immutable audit log for submission, stage/disposition changes, assignment, interview, scorecard, task, and retention actions.
- `ats_notes`: internal notes with author and timestamps.
- `ats_scorecards`: structured interview recommendation, ratings, strengths, concerns, and interviewer.
- `ats_interviews`: interview type, status, interviewer IDs, candidate booking token hash, provider URL, schedule, timezone, and meeting location.
- `ats_tasks`: assignee, due date, status, and completion time.

Normal list/detail reads exclude CV bytes. The CV download endpoint returns the file only after admin authorization. Soft-deleted records stay out of normal reads.

## Application contract

Required:

- submission key (UUID; idempotency)
- role slug matching an open role
- full name
- normalized email
- location and availability
- role-specific answers
- consent to recruitment processing and retention policy
- CV in PDF, DOC, or DOCX format

Optional:

- phone
- LinkedIn, GitHub, portfolio, and other work links
- referral/source

Limits:

- Multipart body: 6 MiB.
- CV: 5 MiB.
- Text fields and answer counts have explicit Zod bounds.
- File names are sanitized and never used as storage paths.
- Submission keys are unique and inserted with `ON CONFLICT DO NOTHING`; a retry returns the original receipt.

## Admin capabilities

- Dashboard counts and pipeline grouped by stage.
- Search by candidate name/email and filter by role, stage, disposition, owner, or tag.
- Candidate detail with structured answers, links, CV preview/download, notes, scorecards, interviews, tasks, and chronological activity.
- Atomic stage/disposition transitions with conflict feedback.
- Assignment, tags, next action, and due date.
- Interview creation and candidate-specific booking URL.
- Scorecard submission with an explicit recommendation; no automated decision score.
- Candidate data export, withdrawal, archival, anonymization/deletion, and retention visibility.

## Interview booking

`ATS_BOOKING_BASE_URL` configures the calendar/provider booking page (for example Cal.com). Creating an interview generates a random token, stores only its SHA-256 hash, and returns a Matrix candidate URL. The public booking route resolves the token, records the access event, and redirects to the configured provider URL with only a non-sensitive interview identifier. Provider webhooks or an admin action can later record the scheduled start/end and meeting location.

## Privacy and security

- Candidate data is company recruiting data in the dedicated ATS PostgreSQL database, not the Matrix platform or customer runtime databases.
- CVs and answers are never logged, sent to analytics, or returned in list endpoints.
- Responses expose generic errors; server logs retain bounded operational context only.
- Mutating Hono endpoints use `bodyLimit`; multipart parsing happens only after the limit middleware.
- All admin operations authenticate before reading candidate existence.
- No automated ranking or model-generated hiring decision is part of the launch scope.
- Retention defaults to 365 days and remains visible/editable per candidate.
- Delete/anonymize is transactional and preserves only a minimal non-identifying audit tombstone when legally needed.

## Acceptance criteria

- A candidate can submit each careers role with a CV and receives a non-enumerable receipt ID.
- Retrying the same submission key creates exactly one application and one submission event.
- Invalid roles, oversized bodies/files, unsafe MIME types, malformed URLs, missing consent, and unauthenticated calls fail closed.
- Hiring admins can list/filter candidates and open a detail view without loading CV bytes.
- Stage changes reject stale revisions and never write an event for a failed transition.
- Notes, scorecards, interviews, tasks, tags, owners, and next actions persist and appear in activity history.
- CV download requires admin authorization and returns safe content disposition headers.
- The careers pages use the structured application flow instead of email.
- Repository tests cover migrations, idempotency, transactions, authorization, validation, redaction, and core UI contracts.
