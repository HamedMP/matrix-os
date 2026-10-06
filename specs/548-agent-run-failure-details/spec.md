# Actionable agent Run failure details

Primary issue: ENG-116. Prerequisite: ENG-114 / PR #2182.

## Problem and result

A signed-out agent account or exhausted allowance can fail before producing any
reply, but Chat currently shows only `Agent work failed` with generic guidance.
Users need to know which action can recover the selected connection.

The failure notice keeps its existing title. Each explanation names one cause
and one recovery step, normally within 75 characters. Supported details include:

- Sign-in required, native usage limits, verified reset time, native credit and billing.
- Matrix AI insufficient credit, reserved credit and monthly budget.
- Temporary throttling, request timeout, lost connection, busy or failed service.
- Conversation length and unavailable conversation history: start a new Chat.
- Native session budget: review the agent budget settings.
- Permissions, unavailable model or agent, invalid response, blocked policy,
  unsupported request and failed agent environment.

A local execution deadline is distinct from a provider-confirmed timeout: it says
to check progress before retrying and does not offer immediate Retry because the
remote outcome may be unknown. Native session budget is never described as the
Matrix AI monthly budget. HTTP 429 denotes temporary throttling, not exhausted
account allowance. A sandbox failure is never inferred to be a permission denial.

Unknown errors keep a short generic explanation. Authentication, financial,
permission and configuration refusals do not offer an immediate Retry that
cannot repair the cause. Existing persisted allowlisted messages and validated
reset templates are recognized and rendered with the new concise copy.

## Authority and privacy

Only terminal native error envelopes and strictly allowlisted durable reason
values supply classification. Ordinary assistant text, tool output, subagent
failures and recoverable error notifications do not fail the parent Run.

Codex app-server prefers its structured error variants and bounded HTTP status
metadata. Native variants were checked against locally generated app-server
bindings from codex-cli 0.153.4; this is compatibility evidence, not a live test
of the pinned 0.156.1 runtime. Older workspace-authentication errors use narrowly recognized native
message prefixes. Non-retrying error notifications are retained only for the
exact active thread and turn, then confirmed by a failed completion. Completion,
abort and the next turn discard prior diagnostic state.

The owner journal stores a small reason enum, never raw provider error text.
The bridge and canonical adapter regenerate fixed reviewed copy. Client display
uses exact code/copy pairs plus the closed validated quota-reset template;
arbitrary safeMessage text cannot appear in a notice or change authority.

No authentication credentials, billing state, admission policy, financial holds,
customer runtime or account login state are modified by this patch.

## Compatibility and parity

Authentication and native credit/usage details reuse existing canonical error
codes and fields. Strict legacy clients continue parsing and can show their
generic fallback. Matrix funding categories retain PR #2182's independent
REST/SSE opt-in projection. Persisted run.error records are authoritative after
reload, reconnect and retry; only the latest attempt supplies its notice.

Shared derivation supplies Electron Desktop, Web Desktop, Web Canvas, Web Mobile
and Native Mobile wherever canonical Chat is rendered. Placement and styling
remain renderer-specific.

## Composition and validation

Keep new classification in small `codex-terminal-failure` and
`claude-run-failure` helpers. Extract the existing Claude classifier from its
large orchestration entrypoint; add only state reset and classification wiring
to the Codex runner. Extend the existing small helper with a typed local timeout
error; the runner retains all lifecycle and child cleanup rules. Add no new
endpoints or network calls.

Tests-first validation covers live/reloaded notices, strict old envelopes,
secret and arbitrary-text rejection, native runner -> journal -> bridge -> Chat,
RPC rejection, retrying notifications, other turns and child-thread isolation,
and genuine credit/usage failures. Complete typecheck, pattern scan and unit
checks, then verify the exact PR commit in Preview VPS and Electron Desktop.
Present Human Review before requesting Greptile or merging.

Public documentation companion in FinnaAI/matrix-os-site describes the safe
failure categories and recovery steps without private incident identifiers.
