# Agent waiting and attachment limits

Tracks [ENG-344](https://linear.app/matrix-os/issue/ENG-344/investigate-unified-matrix-agent-runtime-approval-output-and-upload).
Implementation scope: [633-agent-waiting-policy](../../specs/633-agent-waiting-policy/spec.md).

## Independent clocks

An execution deadline, a work-inactivity deadline, a human response deadline and credential expiry protect different resources. Human waiting suspends only the work-inactivity clock. It never extends an absolute execution deadline, an upstream request timeout, funded credential validity or an approval's authority.

The shared CLI idle control is optional. Claude's canonical adapter uses normalized approval/input request identities to suspend its existing idle timer while at least one request is pending. Resolving one of several requests cannot restart it. Resolving the final request starts a fresh idle interval; provider output during waiting cannot rearm it.

Claude question waiting is bounded independently at 30 minutes by default. Approval controllers retain their existing TTLs. Expired/cancelled/closed questions cannot grant permission or deliver a late answer. The pending registry and all timers are cleared on close.

## Timeout versus Stop

Managed Matrix AI keeps its existing 10-minute absolute deadline. An execution timeout uses the existing reviewed failure: “The agent timed out. Check progress before trying again.” It is not offered as an automatic retry because earlier tools may already have produced effects.

User Stop and subsystem shutdown remain cancellation outcomes. The first abort cause wins, including when the worker responds late or another abort source fires afterward. Cancellation must still revoke local approvals, cancel inference and drain/release the owned runtime.

No source, spending or output limit is increased by this change. Native coding harnesses retain their own transport and approval constraints; a Matrix Chat label is not evidence that the same underlying executor is in use.

## Native Mobile preflight

Native Mobile uses the contracts' managed attachment policy with the current selected instance, model and options before upload or optimistic draft clearing. The same check applies when retrying a failed message under a changed selection.

Managed Matrix AI input remains capped at eight attachments, four images, 2 MiB per image, 1 MiB per ordinary file and 8 MiB total. Images require model vision support and PNG, JPEG or WebP. Default Matrix-funded images additionally share a 1 MiB total budget.

The generic picker and upload endpoint may allow larger files. Their success does not authorize a larger Agent input. Server admission, ownership checks and actual-file validation remain authoritative.

An invalid attachment stays available for removal/editing with a safe error. Upload is not document extraction: PDF/Office parsing and long-term attachment/draft retention remain separate concerns.

## Verification and release evidence

Use fake clocks and fake workers/processes for deadline, waiting, expiry and cancellation ordering. Mock upload/admission to check that invalid combinations fail before any network upload and preserve local draft data. Existing output and funding suites must remain green.

The affected surfaces are Web Canvas, Web Desktop, Electron Desktop, Web Mobile and Native Mobile. The first four consume existing canonical events and reviewed failure copy; Native Mobile additionally changes its preflight. Local unit tests do not qualify any running surface.

Before review/merge readiness, collect current live screenshots and a short recording for each affected surface, validate Native Mobile on an approved device/runtime, and publish the corresponding public behavior documentation in the private matrix-os-site repository. Follow the repository evidence-sharing policy only when external posting is authorized. Do not deploy unreviewed changes to production to obtain evidence.

