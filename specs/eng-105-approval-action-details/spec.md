# Actionable native Chat approvals

Issue: ENG-105. This extends spec 534 and the existing native Codex bridge.

## Problem

A command approval currently reaches Chat as “Run command” with generic waiting
copy. The native request's command/context are absent from the journal, and the
coding-provider adapter drops the description. A user cannot assess the proposed
action before choosing a decision.

## Required behavior

- Show the proposed command and supplied context before the decision controls.
- Show file-change context supplied by the qualified native protocol. If the
  request does not supply a patch or target, say so instead of inventing one.
- Keep bounded, sanitized details in the canonical request so live display,
  reload, and recorded decisions agree.
- Preserve run/request identity, native decision mapping, expiration, and
  approval policy. Unsupported permission grants remain unsupported.
- Preserve existing Custom MCP summaries and their value-withholding behavior.
- Reuse canonical approval presentation for Electron Desktop, Web Desktop,
  Web Canvas, Web Mobile, and Native Mobile. Wrap long content within the card.

## Data flow and privacy

Native request -> shared native display formatter -> detached runner journal ->
AgentApprovalRequest -> canonical provider event -> persisted activity -> shared
canonical approval view -> renderer. The direct native-request normalizer uses
the same formatter. Compatibility/replay must carry the same optional fields.

Reuse the existing bounded approval preview contract where appropriate rather
than enlarging generic labels. Sanitize before persistence. Credentials and
unsafe/private context must not enter rendered fields; hidden and truncated
details receive explicit copy. Never log raw requests in tests or operators'
reports. Missing optional display evidence must not stop approval handling.

No new endpoints, storage models, or authorization sources are added. Details
use the existing Chat activity persistence and a bounded sanitized display cache
in the native runner.
Existing authenticated Chat read and approval-submission routes retain their
owner/access guards, request validation, and run-scoped decision authority.

## Validation and delivery

The user confirmed two test seams: native request to canonical data, and actual
approval-card rendering/decision submission. Use vertical TDD slices at those
seams. Cover masking, malformed/missing details, bounds, JSON replay, command
and file requests, and approve/decline behavior. Keep existing Custom MCP and
session-approval regressions passing.

Run focused tests and project type/pattern checks. Prepare an exact-head Preview
VPS and Electron Desktop for Human Review. Record build/runtime provenance and
a concise manual flow; automated tests alone do not establish live acceptance.
Stop before merge pending the user's review.

Create a separate public documentation PR in FinnaAI/matrix-os-site describing
approval review and explicit unavailable/hidden/truncated content. Keep private
incident identifiers and account/runtime information out of public changes.

## Deferred scope

Claude authentication and its misleading error copy, Full Access semantics,
MCP grants, credential reveal, and native permission-profile support are separate
work. Do not expand authority to make approval details easier to display.

## Qualified native evidence

Qualified Codex 0.159.3 sources:

- [CommandExecutionRequestApprovalParams](https://github.com/openai/codex/blob/rust-v0.159.3/codex-rs/app-server-protocol/schema/typescript/v2/CommandExecutionRequestApprovalParams.ts): optional command, cwd, and reason.
- [FileChangeRequestApprovalParams](https://github.com/openai/codex/blob/rust-v0.159.3/codex-rs/app-server-protocol/schema/typescript/v2/FileChangeRequestApprovalParams.ts): reason and grantRoot; no patch payload.
- [FileUpdateChange](https://github.com/openai/codex/blob/rust-v0.159.3/codex-rs/app-server-protocol/schema/typescript/v2/FileUpdateChange.ts): item path, change kind, and diff.

The runner keeps only sanitized file previews, keyed by turn plus item, with its
existing tracked-item cap and lifecycle cleanup. A missing matching item remains
explicitly unavailable. Preview data never supplies a native grant or response.

## Executable display contract

### Scope and trigger

Native Codex command/file requests cross the detached journal, provider adapter,
canonical activity, and presentation boundary. Each boundary must retain the same
sanitized optional display evidence independently of decision authority.

### Signatures

`codexApprovalDisplay(method, params, { writableRoots?, filePreview? })` returns
the existing title/description/action/risk fields plus optional preview.
`canonicalChatApprovalDisplay(title, description, preview?)` projects review copy.
No HTTP route, environment key, or database schema changes.

### Contracts

`approval.requested.preview` reuses `ApprovalPreviewSchema`: optional safe title,
optional body limited to 2,000 UTF-16 characters and 8 KiB, and `truncated` boolean.
The native formatter masks complete input before bounding it. Absolute targets
inside configured writable roots become relative; unsafe targets are withheld.
At most 20 file changes enter a preview and at most 500 sanitized item previews
are retained, keyed by turn and item and cleared on completion/turn finish.

### Validation and error matrix

| Input/state | Display behavior |
|---|---|
| Supplied safe command/cwd/reason | Show sanitized values |
| Recognized credential value | Mask value or withhold field |
| Unsafe/private path or context | Explicit withheld/unavailable copy |
| Missing command or matching file item | Explicit unavailable copy |
| Oversized review content | Bound preview and show truncation guidance |
| Invalid optional journal/canonical preview | Drop optional evidence; keep approval usable |
| Custom MCP envelope | Keep existing type-only argument summary |

### Good, base, and bad cases

Good: `bun run test` at a project-relative directory appears before Approve.
Base: a file request with no matching started item says patch unavailable.
Bad: `API_TOKEN=fixture-value bun run build` must never persist the fixture value
in display evidence; an item from another turn must not supply the patch.

### Required assertion points

Native/journal tests assert sanitized content, bounds, matching item identity and
unchanged native accept/decline responses. Live/recovery tests assert preview
and description survive canonical transport. Renderer/replay tests assert safe
review copy and existing MCP masking. Built Electron tests assert command review,
decision submission, reload retention, and long-argument containment.

### Wrong versus correct

Wrong: save raw request JSON or infer a patch from an unmatched item, then mask it
only in the renderer. Correct: whitelist and sanitize native evidence before the
journal, pass the optional preview through canonical adapters, and render the
same bounded copy after reload without using it as an approval response.
