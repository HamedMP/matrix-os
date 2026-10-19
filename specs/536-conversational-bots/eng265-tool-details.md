# ENG265 managed Pi tool details follow-up

Issue: https://linear.app/matrix-os/issue/ENG-265/fixchat-restore-matrix-ai-attachments-command-details-and-bot-working

Independent follow-up to merged PR #2514, based on main 25b2f3c8d1.

## Root cause and scope

`matrix_pi` uses `createManagedPiRuntime`, the pinned bot worker and
`mapBotEvent`; it does not use native `pi-run-collector`. The worker only
publishes tool capability/phase, dropping arguments, partial results and final
text. The adapter emits label/status alone. Canonical history therefore has
nothing to expand. Owner tools enforce permissions in the gateway; they do not
supply a separate result display stream. No native shell capability is added.

## Design

Extend the internal broker event with optional bounded display snapshots and
an update/cancel phase. Select known scalar parameter fields, never dump raw
argument/result objects or thinking. Recognized text result envelopes only.
Gateway revalidates display evidence and seals it with the existing runtime
owner key before canonical persistence, using existing protectedPreview and
protectedOutput. Missing keys yield coarse notices. Keep legacy events valid.

The same toolCallId identifies start, updates and terminal activity. Managed
Pi tool outputs are snapshots: the shared web/mobile and Electron projections
use the latest managed snapshot, while Codex/Claude append behavior is preserved.
Parameters accompany each snapshot so replacing partial output retains input.
A bounded per-run mapper retains starts to finish outstanding cards on abort or
failure. No approval/control or broker authorization semantics change (ENG105
approval expansion is deferred).

## Acceptance and validation

- Worker -> broker schema -> managed adapter -> encrypted canonical activity ->
  authorized response -> desktop/web/mobile projection; serialize/reload equal.
- Start/partial/final/failure/cancel keep one card identity; command and selected
  parameters visible only to owner; partial output replaced by final output.
- Empty text, missing legacy details, hidden sensitive output and truncation
  are distinct. Unknown envelopes/binary and credential-shaped content hidden.
- Bounded input/output, capped tools and updates; no unbounded buffers.
- Existing owner/wrong-owner/shared/export tests, Codex and Claude regression.
- Static and lightweight focused tests only in this worktree. Live GUI evidence,
  production shell build and device acceptance wait for parent allocation.
- Independent local review before handoff; no push, PR creation, Greptile,
  formal CI, deploy, merge or Slack action without parent/HumanReview gates.
- Public documentation follow-up belongs in FinnaAI/matrix-os-site after review;
  this implementation records the developer contract in chat-tool-display.md.

Stakeholder review of this scope is suggested by repository policy; the parent
has already authorized the minimal implementation and directed static testing.
