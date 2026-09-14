# Chat sharing, message navigation, and panels

Issues: OM-209, OM-210, OM-211, OM-212, OM-213. One product PR as explicitly requested for this batch; this task-specific scope overrides the generic 50-file splitting guideline. Site documentation is excluded by the user.

## Product contract

- Share creates an immutable, read-only snapshot after explicit disclosure and preview. Only committed user/assistant text is included. Tool output, system context, account data, file paths from attachment metadata, and attachment bytes are excluded. Text authored in a message may itself contain sensitive information; preview and confirmation are required.
- Anyone with an active link may read its snapshot. Links expire and can be revoked by the owner. Later messages never change a snapshot. Revocation cannot recall copies already made by recipients.
- File references and non-image attachments reveal the matching Chat inspector, preserving Chat identity. Attachments resolve in owner home; Project references use the canonical execution root. Existing safe preview APIs remain authoritative. OM-63's changes/diff workflow remains separate.
- HTTP(S) links route to Matrix Browser. Other schemes never become Browser navigation requests.
- User messages support mixed text, 96px square image thumbnails with modal enlargement, and file cards; attachment-only messages omit a text bubble on Web and Electron; long text expands without losing attachments. Image loading, failure, and retry are explicit.
- Inspector sizing retains at least 360px for Chat and accounts for visible navigation. Pointer and keyboard resizing share bounds; narrow layouts retain the existing exclusive panel behavior.

## Verified regression history

- bb90dbfd6 (PR #1514) changed the inspector maximum from 820 to 380 and initialized it at 380, removing the viewport-aware Chat minimum calculation. This prevented any widening beyond the default.
- 6a2897b2a (PR #1484) introduced PanelLeftOpenIcon on the Hide Chat navigation action; Show actions used the close icon.
- OM-182 protections remain required: finite bounded widths, retained Chat content, resize cancellation cleanup, and safe narrow transitions.

## Reference and surface evidence

Live Codex inspection was attempted with computer-use. The tool rejected com.openai.codex for safety reasons. Exact visual/reference acceptance remains pending user-provided evidence and Human Review; do not claim a verified Codex match.

Electron uses canonical Chat; current Web Desktop and Web Canvas use legacy ChatApp. Shared product behavior requires explicit adapters, not an assumption of shared implementation. Current Web Browser routing opens an external page; this gap must be addressed before claiming parity.

## Security and integration

| Route | Access | Validation |
| --- | --- | --- |
| GET/POST /api/chats/:chatId/shares | Authenticated owner | Canonical Chat ID; explicit confirmation, expected revision, and preview fingerprint; 4KB body limit |
| DELETE /api/chats/:chatId/shares/:shareId | Authenticated owner | Canonical Chat ID, UUID; body limit |
| GET /api/share/chats/:token | Public bearer capability | 256-bit random token, SHA-256 lookup; expiry; bounded rate limit |
| GET /shared/chat/:handle/:runtimeSlot/:token | Public platform relay | Strict path allowlist, registered runtime lookup, no user URL input, no credential forwarding |

Storage is owner Postgres. Sharing uses a focused repository instead of adding business logic to the large Chat repository/server composition files. Creation locks the owned Chat, checks its revision, removes expired snapshots for that Chat, enforces ten active shares, and inserts one immutable snapshot in the same transaction. Limit: 200 messages and 256KB of snapshot text; fail rather than silently truncate. TTL: seven days. Expired records are unreadable and removed on later creation; Chat deletion cascades all snapshots. The gateway owns the pool. Reads return generic errors and restrictive CSP/no-store/no-referrer/noindex headers. A failed clipboard copy leaves the created link visible for retry. Public relay fetches are bounded, reject redirects, and use only operator-controlled registered VPS addresses. The platform accepts only schema-validated snapshot JSON and renders escaped HTML itself; owner-supplied HTML is rejected. No credential or owner identity is included in snapshot contents.

## Validation and delivery

Behavioral regression tests precede implementation. Run focused Chat/inspector, authorization, snapshot expiry/revocation, and cross-runtime tests, typecheck, pattern scan, React audit, and production shell build. Capture Web Canvas, Web Desktop, and exact-commit Electron evidence; record Native Mobile/Web Mobile limitations explicitly. Prepare a Preview VPS for backend validation. Yuhan approved Electron Desktop Human Review on 2026-09-07. Merge only after exact-head CI and Greptile 5/5; production deployment remains outside this request.

Public share admission validates the capability route before storage work. The platform reuses the existing trusted edge / Cloud Run / transport source resolver, limits each source to 30 requests per minute and two concurrent relays, and retains global ceilings of 1200 requests per minute and 16 active relays. The gateway permits 120 requests per transport source per minute, with a separate 1200-request capacity ceiling. Nginx X-Real-IP is accepted only from loopback transport; untrusted forwarding headers cannot select a gateway bucket. Platform relay egress is a shared source at the gateway, so platform per-reader admission is deliberately lower. Source maps are bounded to 10000 keys with LRU eviction; active relay entries are bounded by global concurrency and removed on completion.
