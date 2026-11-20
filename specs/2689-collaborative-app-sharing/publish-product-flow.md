---
status: draft
---

# Publish an app and choose how colleagues use it

Tracking: [ENG-29](https://linear.app/matrix-os/issue/ENG-29).
Product clarification: requester, 13 November 2026.

## Intended journey

1. Open the app's existing **Publish app** menu.
2. Choose a Matrix.page destination/access mode or **Share with an organization**.
3. For organization sharing, choose the organization and whether people should
   work together in this app. Reuse an explicit answer from the build request;
   otherwise ask before sharing. Audience and collaboration are separate choices.
4. If collaborative, run the collaborative-app builder/conversion skill and
   verify the exact build, participant identity, attributed actions, shared data,
   concurrent edits, and recovery. Preserve an existing app's records and design.
5. Review the audience/data disclosure and confirm. Members discover the app in
   a distinct organization section of the launcher and use the owner's instance.

These are target requirements, not a claim that main implements them. The
existing collaborative-only V1 spec and mixed launcher tiles describe the
current implementation. This follow-up replaces those UX assumptions when
implemented; it does not silently change authorization in shipped code.

## Required behavior

| Requirement | Observable completion |
| --- | --- |
| One Publish menu | Matrix.page publishing and organization sharing are available in the same control on each qualified owner surface. Web must not require a separate sharing toolbar while Electron uses the contained menu. |
| Explicit destination | Public/anyone-with-link/private/one-time-link publication and organization sharing retain their actual supported access semantics. An organization share never triggers Matrix.page publishing or vice versa. |
| Choose collaboration | Before sharing, ask whether colleagues should work together when the answer is unknown. A request to build a collaborative app already answers this question; do not ask again. Merely belonging to an organization does not answer it. |
| Collaborative app | Every participant uses their authenticated Matrix identity, sees the same intended records, and has their actions attributed separately. No second login or app-invented identity. Confirmed updates survive reopen and conflicts retain input. |
| Simple-use app | A utility, preview, or form can be shared without forcing collaboration-specific UX or pretending it passed a collaborative certificate. Normal app actions such as form submission remain possible when declared and supported. Define a separate safe eligibility path; do not bypass the current verifier. |
| Organization launcher section | Shared apps appear under a clearly labeled organization section, separate from personal apps. Preserve search, keyboard navigation, pagination, membership refresh, people badges, and typed owner-host launch identities. No copied app/data instance. |
| Attributed history | Persist the authenticated actor, operation, app/resource identity, timestamp, and confirmed outcome through the server's existing transaction/idempotency boundary. Replays do not create duplicate history. App-visible activity must use an authorized, safe projection; client-provided author names are never authority. |
| Failures stay truthful | Missing capability, unavailable owner, uncertain save, conflict, ended membership, and stopped sharing have distinct safe recovery states. No optimistic success or data reset. |

Existing gateway `collaboration_operations` and `collaboration_audit` rows already
record actors. That is a foundation, not proof of a useful Linear/Notion-style
activity history inside the generated app. The builder and real two-account
journey must prove the latter.

## Use access and app editing

Confirmed by the requester on 13 November 2026: **Edit changes the app; Use runs it.**

| Access | What it allows | What it does not imply |
| --- | --- | --- |
| **Use app** | Run the app's declared functions, including submitting a form or changing shared records if the app offers that action | Editing source, changing schema, rebuilding, publishing, managing sharing, owner credentials, or unrestricted owner-home access |
| **Edit app** | Explicit app authoring: change its design/code through an appropriately scoped editing workflow | Access to unrelated projects, apps, credentials, provider authority, or owner billing |

Default organization sharing should grant **Use app**. App authoring needs its
own explicit authorization design and should not be inferred from organization
membership or sharing the running app. Record-level read-only access is another
policy, not a synonym for using the app: a form user must still be able to submit.

This does not request record Editor/Viewer roles. Keep V1's membership-derived
full app-use contract. Any future app-authoring access requires a separately
specified scoped authorization boundary; organization membership alone grants
no source editing.

## Main/source audit

At fetched main `5ac81c7f4d360a8c366f6a6d8013a4fb95efa640`:

- `shell/src/components/app-sites/AppSiteButton.tsx` mounts `AppSiteSharePanel`
  without its `organizationSharing` slot. Web organization sharing is separately
  rendered by `AppViewer.tsx`.
- Electron `DesktopAppSiteButton.tsx` supplies `DesktopAppOrgSharingSection` in
  the same contained menu. This is an existing implementation to reuse.
- FR-004 and `launcher-followup.md` currently specify shared tiles alongside
  installed apps, rather than a separate organization section.
- The builder guidance conflates organization use with collaboration. The
  runtime organization-share path currently requires collaborative readiness.
- The app mutation adapter stamps actor identity on receipts/audit rows. The
  starter's participant display does not itself prove action history.

## Implementation units

1. Reuse shared Publish/org-sharing presentation across Web and Electron;
   extract the web toolbar's existing state/transport rather than duplicating it.
2. Add the organization launcher section through shared directory derivations;
   preserve membership, navigation, pagination, and recovery tests.
3. Separate audience from collaboration in builder guidance and sharing UI;
   specify and implement safe simple-use eligibility before enabling that mode.
4. Complete participant attribution and app-visible history with real actor,
   transaction, replay, privacy, and two-account tests. Define app-authoring
   permissions separately using the confirmed Use/Edit distinction.
5. Update public docs through the existing `FinnaAI/matrix-os-site` companion
   work (#356/#357), then collect exact-build surface/member evidence.

Product/design, collaboration, runtime, and security owner review is recommended.
The clarification defines product behavior; no source access is granted merely
by sharing the running app.

## Acceptance matrix

Test collaborative tracker, simple utility, and form fixtures. Use only synthetic
data. Record the platform revision, host bundle's actual Git commit, and client
build; a merged PR or banner label alone is not deployment proof.

- Owner: build/open/save/reopen, choose mode/destination, review disclosure,
  share, inspect launcher grouping, and manage/stop sharing.
- Member: find/open, verify pre-share records, use declared functions, inspect
  real actor attribution/history, change records, and reopen.
- Failure: concurrent stale edits, lost acknowledgement/replay, owner offline,
  runtime restart, changed app build, membership loss, and outsider denial.
- Boundaries: Use cannot edit source/schema/publishing or owner settings;
  explicit Edit (if implemented) remains scoped to the selected app.
- Surfaces: independently qualify Web Canvas, Web Desktop, Electron Desktop,
  and Web Mobile; Native Mobile remains unqualified until its runtime and
  reviewer-approved applicability are resolved.

Screenshots and recordings must name the exact build and fixtures, stay outside
git, and be linked from the PR and Slack #tech. Missing member/device access
remains an explicit release gate.
