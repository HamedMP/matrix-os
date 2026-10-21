# ENG265 managed Pi tool details follow-up

Issue: https://linear.app/matrix-os/issue/ENG-265/fixchat-restore-matrix-ai-attachments-command-details-and-bot-working

Independent follow-up to merged PR #2514. Rebased on main901fbc711f on20 October;
the original c95d625e4f candidate is preserved on a local backup branch. Current
Main1841/942f8571af does not contain this candidate or qualify its behavior.

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

For Custom MCP, opt into bounded intermediate progress on the existing call:
pinned HTTPS SSE notifications -> per-invocation progress-token matching ->
unchanged broker authorization/one-use receipt -> bounded NDJSON -> owner-tools
encrypted canonical snapshot. Use the shared event mapper so command-free tools
retain their lifecycle label/kind and deterministic persistence identity.
Default callers keep JSON responses. Stop aborts only this invocation and does
not delete a remote MCP session shared with concurrent calls. Three updates,
then an explicit pause notice; final result has its own unchanged192KiB budget.
Broker-encoded MCP results expose original text blocks and isError, excluding
internal details/structuredContent. Execution/approval semantics stay intact.

This implements service-provided tool progress, not arbitrary raw stdout. The
original streamed-output requirement remains: verify an identified producer's
actual intermediate output in real acceptance. A final-only tool cannot meet
that item, and progress fixtures do not prove a production stdout contract.

## Acceptance and validation

- Worker -> broker schema -> managed adapter -> encrypted canonical activity ->
  authorized response -> desktop/web/mobile projection; serialize/reload equal.
- Start/partial/final/failure/cancel keep one card identity; command and selected
  parameters visible only to owner; partial output replaced by final output.
- Empty text, missing legacy details, hidden sensitive output and truncation
  are distinct. Unknown envelopes/binary and credential-shaped content hidden.
- Bounded input/output, capped tools and updates; no unbounded buffers.
- Existing owner/wrong-owner/shared/export tests, Codex and Claude regression.
- Static and lightweight focused tests in this isolated worktree; independent
  local review before handoff. Private Preview plus local Electron real tests
  precede the user's review; Greptile and formal CI follow user acceptance.
  Preview artifact builds are distinct from final CI gates. New paid resources,
  credentials, security changes and Main replacement require specific approval.
  GUI acceptance uses one coordinated slot. No merge, production change or Slack.
- Public documentation follow-up belongs in FinnaAI/matrix-os-site after review;
  this implementation records the developer contract in chat-tool-display.md.

Stakeholder review of this scope is suggested by repository policy; the parent
has already authorized the minimal implementation and directed static testing.
