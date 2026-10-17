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
The native ChatGPT subscription catalog projects the authenticated model row's
explicit `input_modalities` into that internal input. Only visible rows declaring
`text` are usable; `image` is retained only when explicitly declared. Missing
modality metadata keeps legacy text-only behavior, and malformed/oversized
metadata invalidates catalog qualification. Audio is not advertised by this
transport. Normalize order/duplicates, preserve existing model/response bounds,
and never infer vision from a slug, display label or another account's catalog.
Tests carry this parsed metadata through the strict peer snapshot and both Chat
and recipe Bot capability projections, retaining account/grant/source fences.
Funded Relay image input is conservatively capped at one MiB aggregate decoded
bytes beneath its existing two MiB whole-body cap. Other remote source limits
can be stricter; do not relax Relay globally to fix the subscription route.

Text inference budgets remain256KiB and peer text requests512,000 bytes.
Additional image allowance is opt-in on the authenticated Bot inference path,
limited to recognized user image blocks and their decoded aggregate size.
Remote image URLs, unknown image shapes, nesting over24, more than32,768 nodes,
and oversized nonimage text/whitespace are rejected. The newly supported large-image subscription transport requires the matching
rebuilt native peer; older peers retain their existing request limits. Native
image bytes must not survive in saved history. Placeholders bound persisted sessions;
they do not authorize or replace subsequent byte consumption. For later turns,
a gateway-owned reader may re-resolve retained canonical upload references from
the same active private Chat into fresh ephemeral native inputs under CURRENT
owner, model, source/account/grant, run and cancellation authority.

The registered reader uses owner-scoped canonical repository reads and requires
the exact active run/latest attempt/turn plus its immutable history boundary.
Only the newest40 candidate committed prior user ai_request upload references
from the most recent40-message prefix are considered; model/session text, stale aliases, assistant/tool/imported data,
referenced Chats, collaboration/shared views and post-boundary records grant no
access. Recheck canonical identity after asynchronous reads/capture and before admission.
Qualify the selected route before local owner-byte capture; once the binding is
admitted, revalidate its current source before dispatch and before/after every
existing chunk/tool read. No revoked grant may receive bytes or inference.

Current submissions remain strict and take priority. Deduplicate retained upload
IDs/owner references; append newest eligible history within the SAME combined
count/per-item/aggregate limits, including funded image1MiB and the CURRENT
model's explicit vision capability. Missing/expired/unsupported/overbudget history
gets a bounded safe unavailable index and does not break unrelated text turns;
invalid current attachments still fail safely. The base prompt and current uploads
retain the existing65,536 UTF-16-unit prompt limit. Fit at most4,096 UTF-16 units of advisory history notices within remaining space;
if required historical alias metadata cannot fit, drop only those ephemeral
history mounts rather than reject an otherwise valid text turn. File access
retains artifact.read authority. Fresh aliases and an authoritative attachment sequence/label index
supersede stale prior aliases without exposing raw owner paths or mounting home.
Labels and bytes remain untrusted data. Existing upload TTL/count cleanup still
limits availability; older/out-of-window or removed uploads require reattachment.
No new public endpoint, wire shape, filesystem mount or native peer protocol is
introduced. Terminal/cancel disposal still clears temporary captured bytes.

Command content uses the existing encryption key with separate AAD
`matrix-tool-preview:v1:<toolCallId>`. `protectedPreview` is an internal sidecar;
only an authenticated configured personal-runtime owner viewing their matching
private Chat receives decrypted `preview`/`previewKind`. Command paths and
newlines are allowed up to4,000 UTF-16 units/16KiB. Recognized credential values,
assignments and private keys suppress the entire preview before encryption.
Legacy plaintext keeps the stricter1,000-character/4,000-byte safe label policy
at every provider ingestion boundary, using `PlaintextToolPreviewSchema`. This
also governs historical plaintext fallback, legacy thread projection and export;
Claude/Hermes must retain coarse fallback when a preview is unsafe. The wider
output schema alone never authorizes raw provider arguments.
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
turn loads a saved history without embedded image base64. A subsequent text-only
request and reopened Chat/Bot must consume retained owner storage again through
fresh aliases/nativepixels without re-uploading; use new image details and a
same-size changed synthetic file marker absent from old replies/session to reject
memory-only false passes. Both managed and recipe routes exercise current
source/grant revocation, owner/Chat/history-boundary rejection, stalealias denial,
combined budgets, missing/unsafe history and cancellation. A path-bearing shell
script survives execution, reload and exact copy in the owner's private Chat.
Base: text-only sends, existing safe short commands and actionable Bot waits
retain their current behavior. Bad: a filename-only prompt, a foreign upload,
credential command, or wire-version flag alone cannot grant data access.

### 6. Required tests and review
Regression suites assert actual installed Pi worker image/file tool behavior,
managed canonical admission and recipe adapter/orchestrator/broker flow, source
and grant fencing, source-specific caps, cancellation and session save/load.
Command suites assert legacy Claude/Hermes coarse fallback and provider-ingress
plaintext rejection alongside runner start/completion, separate crypto AAD, private
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
recognized images through the bounded Bot opt-in, and persist history placeholders and re-resolve authorized retained references for ephemeral later-turn inputs.
Wrong: relax safe labels globally or decrypt owner commands before shared/export
projection. Correct: use the dedicated preview contract and owner-authenticated
projection; strip the protected sidecar at every external legacy/export boundary.

Large-file extraction: existing composition entrypoints receive only delegation
wiring. Admission lives in `admitted-input.ts`, image payload limits in
`image-inference.ts`, command policy in `command-preview-policy.mjs`, and legacy
thread projection in `thread-client-projection.ts`. The repository export edit
is narrowly scoped sidecar removal; broader repository extraction is deferred.

Acceptance-environment recovery follows spec537's ENG-265 contracts. Full platform
deployments preserve and verify the configured internal organization; ordinary
inventory includes only owned private machines without treating them as shared.
Dedicated inventory and immutable release metadata establish PR/bundle/full
commit and expiry. UI availability, subscription connectivity, per-Computer
grants and actual provider pixel/marker evidence remain distinct gates. An
isolated inventory endpoint does not itself prove normal gateway routing. No
Main runtime deployment, credential migration or unapproved source/grant is part
of this recovery.

## Approved Bot layout correction (2026-10-13)
Bot and ordinary Chat must share responsive compact picker behavior so long Bot, connection and model labels do not displace attachment, microphone or folder controls at narrow widths. Phase/current-model Working status follows plain process-row styling while retaining spinner and lifecycle semantics. Final responses use the standard spacing below Worked for receipts; receipt expansion/collapse and Markdown paragraph/code spacing remain intact. Production-component offline browser coverage must include narrow/wide long labels, running/completed status and expanded/collapsed receipts, with no provider traffic. Existing real conversations supply screenshot verification.

## Approved Bot header correction (2026-10-13)

A reduced floating Chat window must show one visible Bot identity/title layer.
The host toolbar and Bot content header must not overlap during their handoff.
Reserve usable space for leading navigation/window controls and Details;
the avatar, name and description must fit or truncate within the actual window
container. Ordinary Chat keeps its existing title and navigation behavior.
Long text must retain accessible identity and Details must remain operable.

Failing-first browser tests mount the production host toolbar and Bot panel,
including hosted and standalone paths, in320/480/900px containers inside a wide
viewport. Verify no title/avatar/control intersections or horizontal overflow,
long name/description, resizing, navigation and Details open/close, and ordinary
Chat regression. Record which actual host mode reproduces the failure rather
than inferring the route from a cropped screenshot. Fresh local production-DOM
screenshots qualify local rendering only; they do not qualify an installed
Electron Desktop, Web host, Preview identity or native/provider execution.
This change adds no model request, source selection, permission or host action.

## Same-session credit diagnostic acceptance
A minimum Desktop QA disclosure may read only the provider snapshot accepted by the existing controller, corroborated through the same existing runtime-pinned ApiClient's ordinary System response. Require the reviewed Computer/runtime/backend source and unchanged auth/runtime generation around asynchronous reads and hashing; abort, drop superseded snapshots and clear output on context changes. HTTP200 and raw positive credit are insufficient: preserve current state, equal asOf, age/future and budget guards. Report selected gateway source as unknown unless using the authoritative UI resolver. Whitelist fixed usage/readiness reasons, presence/empty distinctions and boolean/count projections with pseudonymous source IDs; omit financial amounts, credentials, rawDTO/body/headers, model/user text and arbitrary errors. Expose only normal readonly text, with no new endpoint, IPC, auth/grant, debug port or funded/model call. Same-client System corroboration does not cryptographically attest the ledger identity. Test hostile fields, foreign/stale identity, superseded/unmounted operations and projection freshness before collecting actual same-session evidence.


## Review regressions and fail-closed steering

Rejected optional OpenClaw command previews are omitted through the shared coarse-preview projection; activity identity, status and terminal completion remain authoritative. Expected missing-file or missing-directory conditions anywhere in retained-upload capture make that historical entry unavailable. Current uploads remain strict, descriptors close, and cancellation, source/grant and unexpected storage failures propagate.

Managed Chat and Bot same-run steering channels currently deliver text only. A queued image/file message is refused before invoking those channels, and remains queued with its original parts rather than being accepted as a text-only correction. The normal queued turn retains the existing image/file preparation path. Text-only steering continues to work. This changes neither the broker/native payload nor grants, access or public attachment capability flags. Production-adapter and repository-backed regressions must prove non-delivery, preserved queued status/parts and no spurious committed attachment message.

When composing the shared provider projection and canonical Bot validation from Main, preserve authenticated input modalities in the shared ChatGPT/Anthropic projection used by normal reads and refresh. Missing modalities remain text-only; unavailable observations do not become executable. Owner SOUL and secure input dependencies are both wired into admitted Chat/Bot turns. The canonical isolated validation path remains text-only, with no tool capabilities and its existing one-action/output limits: refuse attachment parts before dispatch, disable optional upload-history hydration for that path, and preserve source/cancellation checks after the isolated envelope claim. Existing completed UI evidence and a packaged renderer from an earlier commit do not qualify the composed source or installed backend.
