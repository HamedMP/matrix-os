# Organization app sharing

Status: draft for product and engineering review. Runtime implementation is pending.
Date: 2026-11-04. Baseline: `origin/main` at `0e16ddeea8`.
Tracking: [ENG-29](https://linear.app/matrix-os/issue/ENG-29/ship-secure-collaboration-and-sharing-across-matrix-os).
Related foundations: [ENG-31](https://linear.app/matrix-os/issue/ENG-31), [ENG-273](https://linear.app/matrix-os/issue/ENG-273).

## Outcome

An owner opens a generated recruiting tracker, chooses **Share**, selects Nima
from their organization, and gives him access to the same running app and data.
Nima opens it from **Shared with me**, moves a candidate, and adds a comment.
Both people see the new state and who made each change.

The requester confirmed that the pilot is a generated Matrix app. The careers
ATS in spec 108 is a separate product/backend and is outside this delivery.
The pilot's exact app slug, source, manifest, and storage have not been inspected.

## Decisions

- Build from the collaboration code on the baseline above. No dependency on an
  open collaboration PR, machine-free entry, or a replacement authority model.
- Add an app-only share path. Sharing a business app must not grant access to
  its source project, Chats, terminals, filesystem, or sibling apps.
- Phase one offers **Can edit** for selected current organization members.
  Reuse the existing Contributor capability internally; the scope owner manages
  access. Keep existing Viewer enforcement and legacy grants working.
- Clerk membership and organization roles are required in phase one. New Clerk
  custom permissions and app-specific roles belong to phase two.
- Share access to the existing owner-hosted instance. Do not clone the app/data,
  publish it publicly, or silently transfer ownership to the organization.
- Organization membership alone does not grant app access. New members are not
  added to existing app shares automatically.

## What main provides

See [research](research.md) for source locations and limitations. Main contains
organization/member management, direct owner-home authorization, exact app
instance/catalog bindings, scoped asset/DB routes, replay protection, revision
checks, events, and actor audit records. New scope creation currently permits
projects only. Registered-app wiring labels apps `scoped`; that is not evidence
that an arbitrary generated app handles multiple writers or attribution safely.

This proposal changes the project-only policy narrowly for qualified app scopes.
It does not reopen standalone Chat, terminal, file, or folder creation. Existing
project sharing and older app scopes retain their authorization semantics.

## Sharing experience

The trusted Matrix host owns the controls, outside the app iframe/WebView:

1. Show **Share** in the app window header on desktop/Canvas and the app menu on
   narrow/mobile layouts. Reuse the same dialog from the launcher app menu.
   Keep **Publish website** a separate action with different wording.
2. Resolve the exact app instance, then show the organization name, app name,
   owner, and an explicit people picker. No preselected recipients or public link.
3. List current members by name/avatar and disambiguating identity. Offer a
   shortcut to **Organization → Members** if someone is missing. Pending org
   invitations are visible there but cannot receive an active app grant.
4. Explain **Can edit**: recipients can use and change the shared app's data;
   they cannot edit app code or manage its sharing. Show selected people before
   the owner commits the share.
5. On success, show pending/accepted access per person. Repeat clicks/retries
   reuse the same scope and grant. A partial failure shows what succeeded.
6. Nima sees the app in **Shared with me → Apps**, accepts through the existing
   grant flow, and opens the owner instance. A copied authenticated deep link
   resolves to that same item; the link itself grants no authority.
7. Replace **Share** with **Manage access** plus a shared indicator. Owners can
   remove access; recipients can inspect their access and leave, not invite others.

Chat is a secondary entry: “share Recruiting with Nima” resolves an exact app,
organization, and member and opens the same reviewed sharing flow. The first
phase does not need a new natural-language mutation tool. Never announce success
from a prepared chat suggestion or bypass the host's authority checks.

## Organizations

Reuse the existing switcher, `OrganizationSectionView`, invitation dialogs, and
platform management APIs. Provide one obvious **Organization → Members** path
from the switcher and sharing dialog. Display active organization, current role,
members, and pending invitations; admins can invite/resend/revoke and manage roles.
Members receive the existing restricted view. Last-admin safeguards remain.

Keep the app's sharing context visible when an organization is switched while
the dialog is open. Clear stale member selections and re-resolve permissions;
never reinterpret a selected person in another organization. Personal workspace
shows a useful organization-selection/setup state, not an empty member picker.

Creating an organization uses the existing supported setup flow. An organization
invitation and an app invitation are separate steps, with separate success/error
states. An app shared under one organization is not rebound to another silently.
Organization roles do not imply resource ownership or sharing-management rights.

## App readiness and adaptation

Share remains discoverable even when an app is not ready. Explain the specific
reason and offer **Prepare app for sharing**, which opens an app-scoped Chat with
the `matrix-app-collaboration` skill and a reviewable adaptation task.

Readiness requires an exact instance/incarnation, compatible host/runtime,
isolated production assets, declared Postgres tables, bounded shared bridge
operations, safe concurrent writes, trusted attribution, and refresh/recovery.
App storage must contain only the dataset the owner intends to expose. An app
with private records, undeclared dependencies, secrets in assets, direct personal
API calls, or arbitrary server processes stays blocked until adapted.

Add a versioned server-validated readiness record bound to app incarnation,
production build digest, and storage/schema revision. An app manifest claim or
the current unconditional `collaborationMode: scoped` projection is insufficient.
Qualify compatibility of each connecting host. A deployment/schema update that
changes the validated contract pauses affected access until requalified; never
keep serving a formerly safe bundle under stale approval.

The preparation skill audits and adapts code/data. It cannot grant access, add
organization members, fabricate runtime methods, or certify a live journey from
a build. Store migration and rollback steps before changing existing data.

## Identity, comments, and activity

Bind actor identity in the trusted host and derive it again from verified
collaboration authority on the owner runtime. The iframe cannot choose an actor,
organization, storage slug, or scope. Display names/avatars come from authorized
directory projections; stable actor IDs remain the durable references.

Add a minimal shared context projection for app code: current actor's public
label/ID, effective access, scope/app identity, and runtime capability version.
The exact bridge method is an implementation contract to define and test; it
does not exist merely because this spec names the requirement. No tokens,
organization directory dump, or owner credentials enter the app.

Server-owned attribution must cover owner and member writes through one path:

- Candidate transition records actor, candidate ID, old/new stage, revision,
  request ID, and server timestamp. UI: “Nima moved this candidate from Screening
  to Interview.” Record only configured, non-secret field changes.
- A comment's author and created time are server-stamped and immutable through
  ordinary app writes. Text and attribution commit together. An edit records its
  real editor while retaining the original author; deletion retains only the
  privacy-appropriate activity/tombstone.
- Domain mutation, attribution/activity, revision, operation replay result, and
  notification/outbox record commit in one Postgres transaction. A failed or
  replayed request never creates a second comment or activity entry.
- Existing coarse `collaboration_audit` rows are useful security evidence, but
  do not alone provide a candidate-linked activity feed or trusted comment authors.

Reuse the existing `db` API shape through a shared host broker where possible.
Define validated server-owned attribution fields and bounded activity mapping
for the pilot's declared tables; no arbitrary SQL or app-supplied audit actor.
Allow only supported mappings; block unsupported apps rather than inferring
semantic events from arbitrary code. Reserve a server authorization step for
phase-two action permissions without creating that permission system now.

Existing records retain their real history. Show **Author unknown** when the
source did not record an author; do not attribute old comments to the owner.
Labels survive deactivation through a minimal privacy-aware actor projection.
Activity reads are paginated, app-scoped, and exclude soft-deleted candidate data
and sensitive comment/CV content unless expressly authorized by the app contract.

## Concurrency and live state

The owner and collaborators address the same declared Postgres data. In shared
mode, owner writes must also use the canonical app adapter; the personal bridge
must not bypass revisions, attribution, or permission checks for shared tables.
Per-app revision serialization is acceptable for phase one. Do not claim row-level
concurrency while independent candidate edits still conflict at app scope.

Use the existing request IDs and revision envelope. Reject stale writes at the
write/lock boundary. Preserve a losing drag/comment draft and offer refresh and
deliberate retry; do not silently replay a stage transition over someone else's
change. Never reload the whole app over an unsaved comment.

Publish existing app-change notifications only after commit and refetch affected
records/activity. Reconnect with revision/cursor reconciliation, including gaps
after a crash. Server-side revocation closes streams and denies subsequent
reads, writes, assets, and replay delivery; pending activation exposes metadata
only. Membership freshness/expiry keeps the current fail-closed behavior.

## Ownership, availability, and scope

Phase one is an owner-hosted app shared with selected organization members. It
is not an org-owned durable app. The owner computer/runtime must be reachable;
the recipient needs the current main collaboration enrollment/runtime prerequisites.
Explain offline/unavailable state without provisioning another computer or using
an upcoming machine-free sharing implementation. Stop editing on lost authority.

Owner departure or unavailable membership evidence fences the share; it does not
transfer the personal app or erase its data. Recipient departure/removal revokes
access. If the app is already inherited from a project, show that source of access
and do not create a competing standalone scope. App-only audiences for such apps
require explicit reconciliation before qualification. Deleting and recreating an
app at the same slug must invalidate its old share.

Sharing does not expose owner integration accounts, AI/tool execution, arbitrary
`bridge.fetch`, private app files, or personal KV/file APIs. Unsupported features
show a clear unavailable state. A generated ATS that depends on platform ATS
admin secrets is not qualified by placing its UI behind an app grant.

## Phase two

Add read-only selection and app-defined actions/roles, such as commenting without
moving candidates, or moving candidates without deleting/exporting them. Clerk
membership/custom permission claims bound maximum authority; the owner-runtime
app policy still enforces every operation. Hiding controls is not enforcement.
Treat org-owned hosting/transfer and independent org continuity as separate
explicit ownership work, not a side effect of adding custom roles.

## Completion

The live owner/member/outsider journey must pass on Web Canvas, Web Desktop,
Electron Desktop, Web Mobile, and Native Mobile. Capture screenshots and a short
recording on each affected running surface at the exact reviewed commit/build.
The ATS pilot must preserve existing data, show Nima's authenticated edits and
comments after reopen, handle concurrent edits and lost connections, and deny a
removed member and outsider. A surface cannot substitute for another. Any N/A
needs architectural rationale and reviewer approval.

Recommend product/design review of Share/Manage access, integration/security
review of the broker/attribution boundary, and engineering review of ownership
and concurrency. See [delivery plan](plan.md) for auth, wiring, tests, limits,
public docs, evidence, and release gates. No runtime journey is qualified by this
spec or by the separately prepared skill.
