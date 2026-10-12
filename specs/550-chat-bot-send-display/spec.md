# Chat and Bot send/display repair (ENG-265)

## User outcome
Matrix AI conversations accept supported image/file input in Chat and Bot. Personal Chat shows the actual command, including owner VPS paths and multiline snippets, through execution and replay. Bot replies use the existing structured working UI without a second polling-driven plain-text Working footer.

All three changes belong to one implementation PR and [ENG-265](https://linear.app/matrix-os/issue/ENG-265/fixchat-restore-matrix-ai-attachments-command-details-and-bot-working) in App Gallery launch.

## Existing contracts
- Matrix-owned Pi and managed subscription/API routes retain their distinct identities and funding/source fences. The Matrix AI label does not prove a GPT model uses funded Relay. Do not add a funded GPT route.
- Authoritative owner-local attachment references enter canonical turns; resolve actual bytes within the selected owner's home. Native image transport must feed actual image content, not just filename/path descriptions.
- Existing worker image transport is capped at four PNG/JPEG/WebP images and two MiB per image. Existing upload limits differ; metadata-invalid input must retain the unsent draft. Byte-level admission failures
  terminate an admitted turn before inference, retaining its submitted attachment references.
- Explicitly submitted files are readable only by their authorized owner/Chat/run. Preserve workspace scope, exact run/runtime generation, cancellation, deadlines and bounded state. File data is untrusted content and cannot grant authority. General file submission does not promise universal PDF/Office interpretation.
- PR #1767 is the bounded tool-details baseline. PR #2058 establishes complete VPS paths in authorized private owner Chat. Paths are not credentials. Preserve recognized credential masking and separate shared/non-owner/export projection.
- Command metadata arriving at completion must enrich the same logical tool activity without inventing a new execution or losing terminal outcome. Already discarded historical data cannot be reconstructed.
- Bot task polling is not canonical run-state authority. Remove queued/running transcript-footer duplicates; preserve pending questions, approvals, waits requiring attention and structured canonical progress/duration UI.

## Authorization matrix
| Boundary | Authority | Change |
| --- | --- | --- |
| Existing attachment upload | Current authenticated owner file access | Preserve upload validation and limits |
| Canonical Chat turn | Existing Chat owner/collaboration authorization | Validate selected model and supported input |
| Bot turn | Direct Chat binding plus saved owner bot definition/route | Forward admitted attachments without widening grants |
| Internal image/file broker | Registered owner/Chat/run/runtime generation and live lifetime | Read only admitted inputs; reject stale/cancelled/foreign reads |
| Private command response | Existing authenticated personal-owner Chat on configured owner runtime | Show complete command with credential masking |
| Shared/non-owner/export response | Existing membership/export authorization plus safe projection | Do not expose private command/path/credential details |

No new public unauthenticated endpoint, datastore, broad filesystem mount or execution permission is introduced.

## Acceptance
1. Failing-first tests prove managed capabilities, canonical admission and worker hydration for actual image bytes; file contents are consumed from the exact admitted input in Chat and Bot.
2. Negative tests cover model vision, MIME/count/size, path/symlink escape, metadata mismatch, owner/run/generation and cancellation fences. Text-only sends and funding/source behavior remain intact.
3. Codex path/multiline/completed-only command details render in private Chat and survive reload. Credential masking and shared/non-owner/export protection retain dedicated tests. Validate managed Matrix AI separately against its admitted tool inventory; direct
   Pi currently has artifact/integration/MCP tools and no shell-command capability.
   This repair does not add command execution to that route.
4. No plain Working footer appears while tasks run or after replies, including stale polling data. Existing structured working UI and actionable requests remain.
5. Exact-head Preview VPS and Electron Desktop verify fresh/subsequent Chat and Bot image semantics and a unique synthetic file marker. Record client, backend, instance/model/access source; fixtures alone are not live provider acceptance.
6. Deliver one PR, then Human Review with a runnable exact-head environment. No primary/fleet rollout or merge is included in this authorization.


## Executable repair contracts

### 1. Scope / trigger
The initial managed Pi capability descriptor rejected every attachment. Codex's
public label filter also rejected command paths/multiline content, even after
PR #2058 allowed owner paths in assistant replies. Bot task polling rendered a
second running footer. This repair applies to canonical Chat and recipe Bot,
with shared UI across Web Desktop, Web Canvas, Electron Desktop and applicable
Mobile clients. Source/funding selection stays authoritative; Matrix AI GPT in
this report uses the linked ChatGPT subscription.

### 2. Signatures
- `botAttachmentInputError(parts, vision): string | null` is shared metadata policy.
- `prepareBotInputs({homePath, expectedOwnerId, ownerId, chatId, runId, parts,
  route, signal, assertActive})` captures submitted bytes once. Its result binds
  a runtime handle/generation, serves image chunks and submitted file aliases,
  and disposes temporary memory on completion, cancellation and failure.
- `validateBotImageInferenceBody(body, maximumTextBytes)` validates recognized
  native image blocks; it never returns model text or image data.
- `CanonicalChatCommandPreviewSchema` validates protected owner preview content.
- `projectChatMessageResponse/Frame(..., commandPreviewVersion = "0")` projects
  the negotiated command display contract. `chatMessageVersionUrl(path)` adds
  `messageVersion=2&inputVersion=1&commandPreviewVersion=1`.

### 3. Contracts
Attachments are canonical `attachment_reference` parts, using existing upload
ownership/auth. Only exact owner upload paths beneath `temporary/desktop-chat/`
are admitted, with validated metadata and directory/file identity; no arbitrary
filesystem input mount is added. Up to eight submitted attachments, four
PNG/JPEG/WebP images, two MiB per image and eight MiB total; ordinary files are
one MiB maximum. Existing artifact text limit is192KiB; binary chunks retain
existing hashing/size checks and do not promise universal PDF/Office extraction.
The internal model's observed `input` controls catalog `supportsVision`. Public
connection model entries remain `id`/`displayName`; projection strips internal
input metadata so old strict clients still parse snapshots and mutation replies.
Funded Relay image input is conservatively capped at one MiB aggregate decoded
bytes beneath its existing two MiB whole-body cap. Other remote source limits
can be stricter; do not relax Relay globally to fix the subscription route.

Text inference budgets remain256KiB and peer text requests512,000 bytes.
Additional image allowance is opt-in on the authenticated Bot inference path,
limited to recognized user image blocks and their decoded aggregate size.
Remote image URLs, unknown image shapes, nesting over24, more than32,768 nodes,
and oversized nonimage text/whitespace are rejected. The newly supported large-image subscription transport requires the matching
rebuilt native peer; older peers retain their existing request limits. Native
image bytes must not survive in saved history; subsequent turns use bounded history placeholders.

Command content uses the existing encryption key with separate AAD
`matrix-tool-preview:v1:<toolCallId>`. `protectedPreview` is an internal sidecar;
only an authenticated configured personal-runtime owner viewing their matching
private Chat receives decrypted `preview`/`previewKind`. Command paths and
newlines are allowed up to4,000 UTF-16 units/16KiB. Recognized credential values,
assignments and private keys suppress the entire preview before encryption.
Legacy plaintext keeps the stricter1,000-character/4,000-byte safe label policy.
Shared/nonowner/export/legacy thread views never receive the protected sidecar.
Wire version0 omits previews incompatible with the older safe-label schema;
version1 changes shape validation only and grants no authorization. Missing or
rotated decryption keys and discarded historical commands keep coarse labels.

Completion enriches the same tool ID without restarting execution. Expanded
cards include command, working directory and bounded output; Copy command
copies exact admitted text. Bot transcript footer retains questions, approvals,
capacity/person waits and safe errors, but omits queued/running polling copies.
Canonical structured progress and Worked duration remain the state source.

### 4. Validation & error matrix
| Condition | Result |
| --- | --- |
| Image unsupported by observed model, invalid MIME/count/declared size | Pre-send error; unsent text and attachments retained |
| Missing/replaced/escaped/symlink/hardlinked upload, metadata/byte mismatch | Generic failed admitted turn before paid inference; submitted references retained |
| Foreign owner/Chat/run/generation or cancelled/disposed input | Reject broker read; no submitted bytes returned |
| Credential-bearing/oversized command or missing key | Coarse Run command label; no private preview |
| Shared/nonowner/export/old thread response | Private command sidecar removed |
| Missing command wire version | Safe legacy projection |
| Invalid/repeated command wire version |400 before service invocation |
| Stale polled running Bot task | No Working footer or empty footer wrapper |

### 5. Good / base / bad cases
Good: GPT subscription Chat receives actual image pixels; an explicitly submitted
text file can be read by its randomized `submitted-inputs/<uuid>` alias. A second
turn loads a saved history without embedded image base64. A path-bearing shell
script survives execution, reload and exact copy in the owner's private Chat.
Base: text-only sends, existing safe short commands and actionable Bot waits
retain their current behavior. Bad: a filename-only prompt, a foreign upload,
credential command, or wire-version flag alone cannot grant data access.

### 6. Required tests and review
Regression suites assert actual installed Pi worker image/file tool behavior,
managed canonical admission and recipe adapter/orchestrator/broker flow, source
and grant fencing, source-specific caps, cancellation and session save/load.
Command suites assert runner start/completion, separate crypto AAD, private
projection, export/thread stripping, old/new HTTP/SSE negotiation and replay.
Built Electron `chat-tool-details.e2e.test.ts` asserts path/multiline script
expansion and exact clipboard text both before and after reload. Bot tests
assert absent footer/wrapper plus retained structured progress/interactions.
Mobile request/event tests assert negotiation and existing auth.

Exact-head Preview VPS plus Electron Desktop live provider review remains
required. Record client/head, immutable backend runtimeVersion, owner runtime,
model/access source, actual image description, unique file marker and subsequent
turn. Fixtures/builds do not establish live paid-provider acceptance. Deliver
one implementation PR for ENG-265, then Human Review; no primary/fleet rollout
or merge here. Repository documentation is updated in this PR; a separate public
site PR is outside the user's explicitly requested one-PR scope.

### 7. Wrong vs correct
Wrong: advertise images based on a Matrix AI label, insert only an attachment
filename into the prompt, and increase every bridge/session limit.
Correct: use observed model input, capture authorized immutable bytes, transport
recognized images through the bounded Bot opt-in, and persist history placeholders.
Wrong: relax safe labels globally or decrypt owner commands before shared/export
projection. Correct: use the dedicated preview contract and owner-authenticated
projection; strip the protected sidecar at every external legacy/export boundary.

Large-file extraction: existing composition entrypoints receive only delegation
wiring. Admission lives in `admitted-input.ts`, image payload limits in
`image-inference.ts`, command policy in `command-preview-policy.mjs`, and legacy
thread projection in `thread-client-projection.ts`. The repository export edit
is narrowly scoped sidecar removal; broader repository extraction is deferred.
