# Continue older native Codex Chats

Tracks [ENG-398](https://linear.app/matrix-os/issue/ENG-398).

## Problem

Native Codex account admission requires a saved account binding. Older backing
threads can retain their native conversation and workspace but lack this field.
The normal follow-up then fails before reaching Codex. Account-connection
recovery does not migrate backing-thread authorization.

## Recovery contract

An authenticated owner's new follow-up may recover a missing binding only after
fresh verification of the currently selected native account and saved consent.
This authorizes a new process resuming owner-held history; it never grants new
authority to the legacy process. Existing nonempty bindings remain strict:
account, configuration, generation or consent drift cannot trigger adoption.

Hold the existing shared session-start reservation through proof, persistence
and launch. Require retained matching owner, project, session, background
incarnation and native conversation identifiers. Obtain process-private stopped
evidence from the background runtime, not the saved status. If still live, use
only the existing exact-conversation idle hibernation handshake and a bounded
exit probe. Busy, unsupported or uncertain processes remain blocked; never kill
them or remove scratch files to obtain a clean start.

Recheck account authority after asynchronous proof, persist the binding through
the existing serialized backing-thread update before dispatch, and cold-resume
the same native conversation with only the newly accepted prompt, attachments,
model and permissions. The existing native child rechecks current authority at
launch/inference. Keep background ownership references for uncertain startup;
do not replay a delivered prompt or fabricate a fresh empty conversation.

No new record store, public endpoint, permission or client-side derivation is
introduced. Existing canonical Chat records remain in owner Postgres; existing
legacy backing-thread/session compatibility metadata keeps its current path.

## Failure and concurrency boundaries

- Missing/foreign/stale runtime identities and failed liveness probes deny
  recovery without dispatch or history deletion.
- Binding-save failure prevents dispatch. A saved binding followed by failed
  startup is safe to retry through ordinary authorized cold recovery.
- The session-start reservation prevents replacement while stop proof is in
  use; the final manager also verifies prior background execution is stopped.
- Stream persistence must positively acknowledge the active accepted turn;
  a discarded update or legacy void publisher cannot authorize dispatch. Existing
  admission and child checks retain revocation/profile-writer safeguards.
- Legacy sessions without a retained native ID or exact background ownership
  cannot be automatically reconstructed. This change does not recover deleted
  native history, reset invalid transcript cursors, or bypass changed accounts.

## Implementation and verification

1. Reproduce the missing-binding failure with real native admission and
   synthetic owner configuration; require red before implementing recovery.
2. Keep recovery and stop-proof policy in focused modules. Existing manager,
   orchestrator and provider composition files get wiring only. The 1,000+ LOC
   backing-thread store gets a narrowly scoped boolean acknowledgement on its
   existing serialized publisher. Its extraction plan is to move that publisher
   and its active-turn checks into a focused store module in a separate refactor;
   this repair does not add another mutation workflow to the large file.
3. Verify fresh binding persistence, exact native conversation reuse, new-prompt
   only delivery, duplicate idempotency, reload, expired registration and
   unchanged retained history. Exercise unknown/active/foreign identity,
   account revocation, publication failure and unsupported idle control.
4. Run existing admission, session-start, workspace/sandbox and provider tests,
   gateway types and pattern checks.
5. The shared gateway path serves Web Canvas, Web Desktop, Electron Desktop,
   Web Mobile and applicable Native Mobile. No surface-specific recovery UI or
   navigation is added. Deterministic backend tests do not establish live
   surface/native-provider acceptance; record missing evidence explicitly.
6. Update developer guidance and open a separate documentation PR in
   `FinnaAI/matrix-os-site` under `content/docs/`, linked to ENG-398. Engineering
   review should focus on authority adoption and partial startup/restart.

No customer-state migration, deployment or live model request is part of local
qualification.
