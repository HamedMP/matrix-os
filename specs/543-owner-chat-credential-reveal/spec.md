# Owner-only credential reveal in Chat

Tracking: ENG-56. This extends ENG-55's private-path behavior in `specs/541-private-chat-path-visibility/spec.md`.

## User behavior and scope

Recognized credential values in newly generated private assistant prose remain masked by default, including throughout streaming, replay, and reload. The personal owner can reveal one captured value with an explicit action in Electron Desktop. Once revealed, that occurrence remains visible across Chat switches and cold Electron restarts until the owner manually hides it. Each load rechecks server-side authority before returning the value. Historical redactions and new values that could not be safely captured remain masked, with an honest unavailable explanation.

The reveal control is an Electron Desktop capability for this release, as requested by the owner. Web Desktop, Web Canvas, and mobile retain masked Chat text with no new reveal control; public snapshots and live collaborators never receive credential values or reveal metadata. This is an explicit surface limitation under the OS-view parity rule.

Public share-link snapshots and live collaboration are distinct. A snapshot contains only sanitized user/assistant text and does not change the owner's private reveal state. Converting the Chat to live collaboration revokes every reveal and immediately removes plaintext from the owner's active renderer. An unshared or later returned Chat does not silently restore the old reveals.

## Source of truth and data flow

Provider-native raw text passes through the bounded assistant stream projector. Only completed recognized credential spans are captured; a safe placeholder becomes the canonical assistant delta. A sealed, owner-scoped sidecar records each captured occurrence and its location. The existing `chat_messages.parts`, `search_text`, list preview, Chat outbox, detail/stream responses, public share snapshot, collaboration read, export, and telemetry remain safe text only. Every persisted reveal preference is a server-side bit associated with one occurrence; the Electron renderer never persists plaintext locally.

The sidecar is in the owner-controlled Postgres Chat database, with an FK to the Chat and cascade on hard delete. Its AES-256-GCM envelope uses a random nonce, bounded value and ciphertext, and domain-separated associated data binding owner, Chat, run, message, and occurrence identity. The key follows the runtime-owned protected-output key safety pattern. Key absence, corruption, oversized values, or capture failure yield masked-only output; no plaintext fallback exists. Existing upstream coding-agent thread/journal files may retain raw provider output under their separate owner-home contract and are not used as the Chat reveal source.

## Authorization matrix

| Surface/action | Personal owner, private Chat | Personal owner, live collaborative Chat | Other principal / org / anonymous |
|---|---|---|---|
| Ordinary Chat detail, stream, list, search | Masked prose; no sidecar value | Masked shared projection | Existing scope-authorized masked projection only |
| Credential occurrence metadata | Bounded IDs/offsets/reveal state | Deny | Deny |
| Reveal one occurrence | Explicit action; return one bounded value | Deny and revoke | Deny |
| Rehydrate previously revealed occurrence | Return one value after current-state check | Deny | Deny |
| Hide one occurrence | Persist hidden state | Deny; already revoked | Deny |
| Public share snapshot | Sanitized immutable text only | Sanitized immutable text only | Sanitized immutable text only |
| Collaboration read/export | N/A until conversion | Sanitized text only | Sanitized text only |

The gateway derives identity from `RequestPrincipal`, then requires a personal owner-scope match, the configured runtime-owner allowlist, current Chat ownership and private collaboration state, and exact message/occurrence binding. A caller cannot choose an owner ID or ciphertext. Every value read rechecks the authoritative Chat row under the same locking order as collaboration conversion. Denials use a uniform bounded response that does not distinguish absent, hidden, shared, or unauthorized values. A collaboration transition clears reveal state in the same transaction and invalidates active clients; a disconnected or unauthenticated renderer clears plaintext until it can reauthorize.

## API, validation, and limits

The new sidecar API is separate from canonical Chat detail and SSE contracts for old-client compatibility. A bounded metadata GET accepts only validated message IDs and returns occurrence IDs, safe offsets/lengths, and reveal flags, never ciphertext or plaintext. Single-occurrence reveal and hide mutations use `bodyLimit` (1 KiB), validated Chat/occurrence IDs, `Cache-Control: no-store`, a per-owner request rate limit, and a 5-second DB statement timeout. A single-occurrence read returns plaintext only for a previously revealed value after a fresh owner/private check. No multi-value plaintext endpoint exists.

| Route | Authentication and authorization | Response |
|---|---|---|
| `GET /api/chats/:chatId/credentials?messageIds=...` | Request principal, personal runtime owner, current private Chat owner | Bounded occurrence metadata only |
| `POST /api/chats/:chatId/credentials/:occurrenceId/reveal` | Same check, plus occurrence/message binding | One value and saved reveal state |
| `GET /api/chats/:chatId/credentials/:occurrenceId/value` | Same check, and that occurrence was already revealed | One value for restart or Chat-switch rehydration |
| `POST /api/chats/:chatId/credentials/:occurrenceId/hide` | Same check and binding | Saved hidden state, no value |

None of these routes is public. The gateway rejects absent or malformed IDs and request bodies at the route boundary. It never accepts an owner ID, ciphertext, or a batch of occurrence IDs from the caller. Every response is non-cacheable; error bodies are bounded and contain no provider or database details.

Initial resource ceilings: 16 revealable occurrences per message, 1,024 per Chat, 2,048 UTF-8 bytes per value, and 64 message IDs per metadata request. Exceeding a ceiling keeps the assistant text masked and marks the value unavailable to reveal. The implementation may tighten these constants if tests or existing protocol bounds demand it, but must never weaken the masked fallback.

## Streaming, retries, and lifecycle

Claude, Hermes, and coding adapters use the same credential classifier while retaining their provider-specific buffering and suppression paths. Split key names, Bearer values, multiple values, Unicode, malformed/oversized candidates, failed tool text, and provider recovery need regression coverage. The provider's canonical event carries only safe text plus an optional sealed sidecar. The Chat append transaction writes safe text and ciphertext/offset records atomically, with stable occurrence identity and conflict-safe idempotency. It never emits ciphertext into the outbox. Existing replay/cursor behavior continues to publish safe text.

Recovery can prefix-merge already persisted safe text. Captures already stored at unchanged offsets remain available; newly recovered suffixes without sealed capture stay masked and unavailable. Failed/aborted runs follow the same safe read path. Deleting a Chat removes sidecar rows through the FK. A rollback may leave inert ciphertext until normal Chat deletion; key loss makes it unavailable, not visible.

## Electron Desktop interaction

Each captured occurrence turns its validated `[redacted credential]` marker into an inline, keyboard-accessible control in Electron Desktop. Activating that marker fetches only that value and displays it at the same position in the assistant message; activating the revealed value hides it locally and durably, restoring the marker. There is no separate credential disclosure area. Reopening the Chat or restarting Electron rehydrates only occurrences already marked revealed, after a fresh owner/private check. The canonical Markdown, generic message copy, list/search previews, analytics, and shared screenshots remain masked. Historical/uncaptured placeholders have no misleading reveal action, and the UI explains why they are unavailable. Multiple captured markers map to their exact positions independently, including when the message contains other Markdown formatting.

`CanonicalChatWorkspace.tsx` is already above the repository's 1,000-line composition threshold. This change keeps credential state and view logic in focused hook/component modules. A follow-up extraction should move the generic Chat rail/navigation and composer orchestration into their own hooks or components, leaving the workspace as composition; mixing that broad refactor into this security change would obscure its authorization review.

## Verification and release gate

Tests must prove split-stream masking, bounded/atomic capture, retry consistency, owner and runtime-owner authorization, public snapshot separation, collaboration revocation/races, old-client safety, export/outbox/search exclusion, key failure, deletion, persistent reveal/hide, keyboard accessibility, and the exact historical unavailable state. CI and typechecks precede a production Electron Desktop build. The exact PR head must deploy to a healthy Preview VPS with matching immutable runtime version; the matching Electron Desktop build must then pass real new Chat, switch, cold restart, snapshot, collaboration, and historical-redaction checks. Human Review, Greptile 5/5, green exact-head CI, and a separate `FinnaAI/matrix-os-site` public-docs PR are release gates.

Local implementation evidence before the PR: 280 focused cross-layer tests, 17 Chat event-stream tests, and 228 provider tests passed; repository typecheck, Electron Desktop production build, and diff pattern scanner passed. The repository's shell-only `bun run lint` could not start in this isolated worktree because `eslint-config-next` could not resolve `next/dist/compiled/babel/eslint-parser`; no dependency or lockfile change was made for that unrelated install condition. Exact-head CI and live Preview/Electron acceptance remain separate gates.
