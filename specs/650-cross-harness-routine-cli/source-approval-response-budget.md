# Source-Chat approval response budget

## Observed boundary and scope

A source-Chat schedule decision commits before its canonical continuation is admitted. The browser client currently applies its ordinary ten-second request deadline to this whole decision request. A valid acknowledgement delayed by continuation/catalog preparation can therefore be abandoned even after the decision is durable. Live activation was independently verified while the browser showed an unconfirmed notice; the original browser transport error was not captured, so that observation alone does not establish its cause.

Repair the demonstrated slow-acknowledgement client boundary only. Reuse request-specific timeout options and one shared policy to allow thirty seconds for the source-Chat decision POST in both the ordinary Web Desktop/Web Canvas client and the existing owner-browser completion page used by native clients. Keep ordinary reads and other operations at their existing deadline. This network response budget is separate from the thirty-minute human operation/source-consent window.

No authority, signature, route, database, approval semantics, canonical continuation, provider selection, scheduling or retry policy changes. Browser source consent, human schedule activation, task background consent and integration permissions remain independent. A response still unresolved at the deadline remains uncertain; never retry a decision automatically or infer success from a vanished card.

## Test-first verification

1. Reproduce a valid delayed decision acknowledgement through the real Web Desktop client and shared source-Chat response parser, plus the owner-browser completion transport: a response after twelve seconds must resolve once instead of aborting at ten seconds. Retain the actual request AbortSignal and strict response shape; a setup failure or constant-only assertion is not the named regression.
2. A never-settling request remains bounded, explicit caller cancellation still wins, and neither path automatically repeats the decision.
3. Correct any touched existing success fixture that includes fields rejected by the production strict response schema, and assert successful acknowledgement rather than only the submitted URL/body.
4. Run the focused client/shared UI checks, relevant types, patterns and independent review. Do not promote synthetic timing tests to a live approval or complete lifecycle pass.

## Delivery

Ship an independent Draft PR above the exact subscription-admission test commit. Build/install the resulting exact source on the authorized Dev only after checks pass. Real browser confirmation, delayed original-Chat output, pause/resume/archive and retained history remain separate live gates. The existing public source-Chat guide PR remains the documentation deliverable; no public command or permission contract changes.

## Owner clarification: scheduling is available by default

The owner explicitly requires no Settings authorization switch for scheduling. The connected ChatGPT panel already explains that schedules are approved in Chat without a Settings switch; approved task-scoped routines also execute with general background consent disabled. Preserve that behavior and the separate per-task approval.

Remove misleading schedule language from the shared Claude Bot-use panel's general background-task checkbox. Explain that scheduling is available by default and persistent Matrix tasks are reviewed in Chat. Do not automatically enable general background access, mutate grants when opening Settings, remove account connection or change integration authorization. Share this presentation across applicable OS-view renderers and add a focused semantic regression for the misleading gate.
