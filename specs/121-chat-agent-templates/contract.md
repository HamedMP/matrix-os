# Template and execution data contract

Proposed schema version 1. This is a normative specification, not executable product code. [Behavior and security](spec.md).

## Definition

Markdown body contains original method instructions. Frontmatter is parsed as data by a strict Zod 4 schema; reject unknown executable fields, duplicate keys, invalid IDs and unknown versions. Never evaluate template expressions or load dependencies from URLs.

| Field | Type / bound | Meaning |
| --- | --- | --- |
| `schemaVersion` | literal `1` | Parser contract |
| `id`, `version` | safe slug ≤80; semver ≤32 | Stable template identity and immutable revision |
| `name`, `summary` | text ≤80 / ≤280 chars | Original user-facing text |
| `provenance` | `{kind: matrix_original, license: AGPL-3.0-or-later, inspirationUrls: string[]}`; ≤5 HTTPS references | Attribution references only; not executable URLs or a claim of upstream endorsement |
| `job` | text ≤500 chars | One concrete user outcome |
| `trigger` | literal `manual` | No schedule/recurrence activation |
| `inputs` | discriminated input schema ID plus ≤4 connection slots | Typed required/optional context; arbitrary JSON Schema execution is excluded |
| `authority` | `{mode: draft_only, harnessTools: none, externalWrites: denied}` | Enforced execution profile, not a user-editable promise |
| `cap` | bounded numeric fields below | Work, source and output ceilings |
| `proof` | known result schema ID | Output sections and evidence requirements |
| `readback` | known verifier ID | Server validator selecting a fixed implementation, never template-supplied code |
| `escalation` | array of known reason codes, ≤12 | Stop conditions and what the user can repair |
| `owner` | literal `chat_owner` | Resolve authenticated personal owner at launch; never ship a creator account ID |
| `executionProfile` | literal `context_snapshot_draft_v1` | Requires adapter attestation; no implicit full-access fallback |

Method body ≤8 KiB. Prompt assembly keeps existing kernel system-prompt budget below 7K tokens; put bounded source material in explicit untrusted input blocks, not the global kernel prompt. Template instruction order cannot override OS security or authenticated owner policy.

Input schema IDs are `meeting_brief_v1` and `sponsorship_reply_v1`. Both accept up to 10 pasted sources, each `{label, text}` with label ≤120 chars and text ≤8 KiB. Total pasted plus connected text ≤48 KiB. Required core text fields are non-empty, ≤4 KiB each. Titles, labels and other display strings reject control characters and HTML execution. Source selection is a strict union, not a generic action payload:

- `pasted_text`: bounded content already supplied by the user; optional declared date, labeled user-provided rather than externally verified.
- `gmail_messages`: own immutable `connectionId`, explicit list of message IDs (≤10), using only `get_message`. Optional discovery uses bounded `list_messages` with user-entered query ≤200 characters, ≤20 returned IDs; the user selects messages before preparing body content.
- `calendar_events`: own immutable `connectionId`, selected event IDs (≤10), UTC start/end ≤7 days apart and timezone. Execute `list_events` in that interval, project only selected IDs and fail if they are absent. Do not treat undisclosed additional events as approved prompt context.

The gateway maps these variants to compile-time registered read actions. It validates source ownership and response type/size. It does not allow a client to name an arbitrary action, service URL, MCP server, shell command or credential. Calendar and mail API responses may carry more data than the selected fields; normalize/minimize before preview storage and model transmission, discarding unused response data. Source discovery is visibly a real account read.

## Original seed definitions

These are Matrix-authored examples. Public Grok jobs informed the choice of use cases; no Grok profile prompt, standing commercial term or skill bundle is copied.

| Dimension | Meeting Brief | Sponsorship Reply Draft |
| --- | --- | --- |
| Job | Prepare one meeting's decision brief and questions | Draft one response to one sponsor inquiry using owner-provided terms |
| Trigger | User starts or continues Chat | User starts or continues Chat |
| Inputs | Required meeting objective and supplied meeting context; optional selected Calendar event and Gmail messages | Required inquiry and owner's rate/constraints text; optional selected Gmail message |
| Authority | Read chosen snapshot; draft only; no tools | Read chosen snapshot; draft only; no email draft creation in Gmail and no sending |
| Cap | One brief, ≤5 questions, ≤20 sources, ≤10 preparation calls, 120-second run, 16 KiB output | One reply, ≤5 clarification questions, same source/call/time/output caps |
| Proof | Objective, facts with source IDs, open questions, risks, missing context and prepared-at time | Proposed reply, supporting terms with source IDs, unresolved exceptions and missing context |
| Readback | All referenced sources exist; required sections present; no claim a follow-up was sent | All referenced terms come from supplied context; sections present; no claim a reply was sent |
| Escalation | Missing meeting context, conflicting dates/identities, source failure, cap reached, expanded authority | Missing rates, contradictory obligations, source failure, cap reached, request to commit/send |
| Owner | Authenticated Chat owner reviews and acts outside this template | Authenticated Chat owner reviews and acts outside this template |

Proposed original method for Meeting Brief: identify the decision the meeting should support; distinguish source facts from questions; group facts by topic; cite source IDs beside factual claims; expose contradictions and missing information; return the brief and five or fewer questions. Do not browse, contact attendees, schedule anything or claim live verification beyond the snapshot.

Proposed original method for Sponsorship Reply Draft: extract the ask from the selected inquiry; compare it against the owner's supplied terms; identify exceptions without inventing prices; draft one reply and mark unresolved points. Do not accept a deal, create an external draft, send a message or infer approval from the inquiry.

## Binding, preview and per-turn snapshot

Use separate definition/configuration and execution objects; do not store runtime state in the distributed Markdown.

```ts
// Illustrative shape; implementation must use strict bounded Zod schemas.
type TemplateBinding = {
  chatId: string;
  ownerId: string; // server-derived, never trusted from input
  template: { id: string; version: string; sha256: string };
  definitionSnapshot: string;
  inputSchemaId: 'meeting_brief_v1' | 'sponsorship_reply_v1';
  authority: 'draft_only';
  executionProfile: 'context_snapshot_draft_v1';
  createdAt: string;
};
type PreparedContext = {
  id: string;
  ownerId: string;
  templateHash: string;
  projectId: string | null;
  selectionHash: string; // exact V3 harness/account/access source/model choice
  sourceSelectionHash: string;
  contextHash: string;
  sources: SourceSnapshot[];
  proposedFirstMessage: string;
  preparedAt: string;
  expiresAt: string;
};
type SourceSnapshot = {
  id: string; // opaque source reference in the prompt/result
  kind: 'pasted_text' | 'gmail_message' | 'calendar_event';
  connectionId: string | null; // private binding, not in model-facing projection
  resourceId: string | null;
  label: string;
  normalizedText: string;
  sourceTimestamp: string | null;
  retrievedAt: string;
  sha256: string;
};
```

All identifiers follow existing canonical reference constraints where applicable; use UUID/opaque IDs for new preview/source records. Persist per-turn linkage `{chatId, turnId, snapshotId, snapshotHash, definitionHash, executionProfile, selection}` and a versioned verification receipt. Owner ID is part of all queries and unique scopes; foreign keys cover binding/Chat/turn/snapshot relationships. Two related inserts or updates must share a transaction. Retain exact selection in the canonical run record; a hash is not a second selection store.

Preview storage has TTL and quota; accepted snapshots move to Chat retention. No sensitive data is written to repository files, analytics or general logs. An owner Chat export includes definition, bounded inputs/snapshots and receipts but excludes credential values and opaque provider auth state. On deletion remove previews linked to that Chat and use the canonical deletion policy for child records; soft-deleted material stays out of normal/export reads. Preview IDs must not become reusable cross-owner bearer grants.

Template catalog absence on another release does not erase the pinned definition. Reads must distinguish a valid old snapshot from a disabled unsafe template. Local tampering with shipped definitions must not silently replace trusted hashes or admit an unknown execution profile.

## Result and completion readback

Each template requests a structured object bounded to 16 KiB: `schemaVersion`, `templateId`, `status` (`draft_ready`, `needs_context`, `partial`), template-specific sections, `sourcesUsed` (≤20 opaque source IDs), `missingContext` (≤10 bounded strings), `limitations` (≤10) and `readback`.

The gateway validates this object and generates its own receipt, rather than trusting the model's claim of completion. The receipt records run ID, template/snapshot hashes, required-section check, source-reference check, output-limit check and execution-profile enforcement status. Never infer enforcement from model prose. Unknown source IDs or malformed structure mean **verification incomplete** with the readable draft preserved; offer correction via another user-requested canonical turn, not an automatic unbounded repair loop.

Deterministic validation cannot prove that every sentence follows from its citation. UI wording is **Draft ready — structure and source references checked**, not “facts verified.” Unsupported claims and contradictory inputs are reviewer concerns and must be exposed. Proof does not mean a provider exit code of zero. No assistant content is an ordinary canonical failure, not an empty successful template artifact.

Readback includes what was produced, which sources were used, snapshot age, missing context, whether limits interrupted work, and the enforced absence of external actions. Verification status is metadata on the canonical run result, not a competing run status machine. Streamed text is provisional until validation; unsupported structured output does not silently earn a success badge.

## Explicit recovery decisions

| Condition | Behavior |
| --- | --- |
| Connection renamed | Resolve stable ID; display current label; do not alter account selection |
| Connection removed/replaced | Block refresh/launch involving that ID; require explicit new selection |
| Preview expired | Preserve setup, request a new preparation; do not launch with stale authority |
| Catalog/selection changed since preview | Return conflict and show new preview; do not auto-accept |
| Provider is unavailable | Keep draft/setup and show V3 recovery action |
| Cross-harness continuation | New compatible execution state from canonical transcript, never foreign resume blob |
| External text asks to send or reveal secrets | Treat as untrusted input; no tools exist to perform the instruction |
| User requests broader authority | Explain scope; no escalation into full-access execution inside this binding |
| Review or navigation failure after admission | Recover by request ID/canonical Chat ID; do not create another Chat |
