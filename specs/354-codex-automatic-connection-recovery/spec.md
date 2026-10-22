# Automatic recovery of saved Codex connections

Tracking: [ENG-354](https://linear.app/matrix-os/issue/ENG-354/fix-web-desktop-codex-auth-consistency-logout-and-provider-recovery).
Related: [PR #2810](https://github.com/HamedMP/matrix-os/pull/2810), which adds an explicit completion action and broader Web Desktop recovery.

## Behavior

A saved native Codex selection and valid ChatGPT login already represent the
owner's connection. Missing Matrix account binding/completion bookkeeping must
recover automatically when the owner opens Settings or discovers Chat providers.
No additional consent screen, Reconnect click, login process, or credential write
is needed. Projected `enabled:false` describes readiness, not user intent.

The gateway repairs only a single saved, enabled fixed OpenAI Codex route selecting
`owner_openai_profile` and `owner_codex`. A fresh private native principal proof is
required. An existing generation must match; recovery never switches a previously
bound account. API-key selections, other harnesses, absent credentials, and
previously bound account changes retain their existing flows. Runtime unavailability
is independent of this repair. Actual logout/revocation remains authoritative.

A failed completion returns existing retryable unavailability, preserving saved
configuration and credentials. Unknown native observations remain unknown; they do
not revoke a saved connection. Missing or invalid authentication keeps existing
authentication-required behavior. No presentation/color changes are included.

## Authority and wiring

| Existing entry | Authentication and recovery authority | Public |
| --- | --- | --- |
| GET `/api/ai/provider-settings` | Existing authenticated route; server runtime-owner resolver alone enables repair | No |
| GET `/api/chat-providers` | Existing authenticated principal; configured runtime-owner allowlist alone enables repair | No |
| Execution admission | Existing owner, exact route/revision, private principal, and session checks; no new repair authority | No |

`recoverNativeConnection` is a server-only read option, never a renderer/query
option. Metadata enrichment alone does not grant mutation authority. Managed and
canonical Matrix AI reads bypass native repair entirely. Discovery and metadata
probes remain outside the settings writer lock. The repair reuses
`completeCodexNativeLogin`: revision check, fresh identity proof, exact installed
route, runtime saga/rollback, final proof, atomic settings commit, and receipt.
The earlier observation is bound to the completion's principal. The existing
writer/profile fences and timeout policies remain in force. No raw token, principal,
customer identifier, or synthetic consent value is created or exposed.

A single in-flight promise per store coalesces repairs; it is cleared on success
or failure. No timers, background jobs, unbounded collections, or shutdown work
are introduced. Concurrent settings mutations win through the existing generation
and revision fences. Saved settings are the route source of truth; native proof
is the identity source of truth. Runtime receipts are compensated on failed commit.

The gateway composition change is wiring only. Its existing extraction plan is
`specs/536-conversational-bots/plan.md#gateway-entrypoint-extraction`; the new recovery
policy lives in a focused module rather than adding policy to the entrypoint.

## Acceptance and validation

- Reproduce authenticated CLI + saved native selection + absent binding as a failing test.
- Owner Settings and Chat reads persist one verified repair; Chat becomes selectable
  and ordinary native execution admission accepts the same principal.
- Concurrent reads produce one settings revision; subsequent reads are idempotent.
- The first repaired response preserves independently reverified native account
  details and usage for other connected providers at the committed settings revision.
- Collaborator/ordinary reads cannot repair, including forged query options.
- Rejected/expired proof, different account, API-key route, concurrent revocation,
  and runtime failure cannot silently enable or replace credentials.
- Failed repair returns retryable unavailability; a later read recovers without user action.
- Run focused gateway suites, typecheck, pattern checks, CI, and Greptile review.
- Capture matching-build live Settings and Chat journeys on affected surfaces.
- Follow up with a separate public-safe documentation PR in
  `FinnaAI/matrix-os-site/content/docs/`, documenting automatic recovery and genuine
  authentication failure. The repository's existing ticket limits implementation
  to matrix-os; link the separate documentation deliverable before release.

## Surfaces and review

Shared gateway state reaches Web Canvas, Web Desktop, Electron Desktop, Web Mobile,
and Native Mobile wherever native Codex Settings/Chat exist. No UI components or
contracts change. Validate each affected surface on a reviewed test runtime,
including screenshots/recordings, exact build, and parity evidence. Local fixtures
prove backend behavior, not live visual qualification. Missing access is a readiness
blocker, and any N/A designation needs architectural rationale and reviewer approval.

The requester approved automatic recovery. Recommend engineering/integration owner
review of the recovery and account-switch boundaries, coordinated with #2810.
No production customer mutation, deployment, or rollout is part of this PR.
