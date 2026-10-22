# Codex and Claude subscription connections

Tracking: ENG-117 / PR2198. Native CLI dual-entry correction: ENG-268, 2026-10-13.

The native Codex restoration contract is [Independent native Codex and Matrix AI subscriptions](./codex-dual-entry.md). It supersedes the former blanket Terminal-login exclusion. The subsequently authorized [native Settings device-code restoration](./native-codex-settings-device-login.md) also supersedes Terminal-only native capability for the qualified owner-scoped official workflow.

## Outcome

The Matrix AI Settings area exposes **Connect Codex** and **Connect Claude** for
the qualified native connection workflows on the selected Computer. Claude Code
uses its unmodified official login; Codex exposes the owner-operated official CLI
Terminal fallback and qualified in-Settings official device-code login on the
selected Computer under the native restoration contract. API-key connection
and existing nonsecret native account display remain supported. Hermes, Pi and
OpenCode expose qualified permitted connection methods and **Log in in Terminal**
where the installed native protocol supports it. Selecting a
provider binds that provider to validation, native persistence, readback, catalog
and execution admission. A connected native account, permission to use it in Bots
and an executable model route remain separate observations.

Other provider additions and new OpenClaw behavior are deferred. Preserve existing
qualified OpenAI, Anthropic and OpenRouter API-key/native behavior. Restricted
subscription routes are excluded from this delivery, including direct Claude
subscription inference inside Hermes, Pi or OpenCode and unapproved Matrix-owned
ChatGPT inference. Do not fill an unsupported native model row with hidden official
agent delegation or a Terminal workaround.

## Authorization and execution sources

| Source | Execution | Eligibility |
| --- | --- | --- |
| Matrix AI credit | Existing private Pi inference broker | Preserve current funded admission and model proof |
| Owner API key | Qualified native harness or explicit Pi broker route | Fixed provider, current credentials, catalog and exact owner selection |
| Owner-operated native Codex login | Official Terminal or qualified Settings device-code flow | Current writable Computer owner, qualified installed protocol, profile fencing and private exact native completion |
| Separate hosted Codex OAuth integration | Outside this restoration | The qualified owner-scoped native Settings flow does not establish eligibility for unrelated hosted integrations |
| ChatGPT subscription for Matrix Pi | Deferred from this delivery | Own issued client and confirmed deployment/access eligibility required; native Codex login alone is insufficient |
| Claude subscription for Bot tasks | Unmodified official Claude Code child executor | Existing end-user native login, explicit Bot grant and scoped child authority |
| Claude subscription for direct Pi/Hermes/OpenCode inference | Excluded | No native credential import, login advertisement or Terminal workaround |

Never silently fall back to Matrix credit, another account or another source.
Subscription usage is not a fabricated USD balance. Any Pi coordinator inference
has its own explicit funding source.

## Connection workflow

Connect opens a provider and method chooser from a bounded server catalog. Already
valid authorization is reused for the exact permitted consumer. Missing Matrix app
consent or Bot permission asks only for that missing step. A login on another
Computer or in the provider's website does not establish runtime authorization.

Matrix AI SIWC and native Codex retain independent authorization operations,
accounts and credential custody. Valid same-route native login shows its verified
connection state rather than destructively reopening sign-in. Native Codex uses
the qualified official owner-scoped Settings device-code flow or CLI Terminal fallback.
Neither path imports the upper subscription entry's credentials.
Keep Matrix credit and owner subscription usage visibly separate.

Use existing account cards, verified identity and supported Connect/Reconnect/
Change account actions. Ordinary setup does not require saved-account management
or advanced configuration. Subscription allowance/reset appears only if observed;
otherwise show Usage unavailable. A supported native TTY login opens the canonical
Terminal with visible progress and cancellation. It runs a fixed version-qualified
native command on the selected Computer and confirms account/catalog readback
before reporting connection success. Restricted subscription methods are omitted;
an installed-version failure remains a truthful unavailable state.

Disconnect from Bots revokes Bot use without signing out unrelated native
consumers. Full provider sign-out states its scope. Background/recurring subscription
execution requires separate express authorization.

## Contracts and compatibility

Keep strict V1 workflow response and request shapes unchanged. V2 lives under
`/api/ai/provider-settings/workflows/v2` and advertises provider-qualified option IDs.
Each option has a fixed provider, auth kind, method where applicable, billing kind,
execution kind and availability. V2 login/key requests send the exact option ID;
the server resolves it against the current registered adapter before effects.
Install/uninstall continue through V1 operations.

Qualification also applies to legacy mutation endpoints: Pi, OpenCode, Hermes
and OpenClaw subscription-login/import starts remain unavailable until their
provider access is qualified. A V1 request cannot bypass a V2 unavailable option.
Generic install/uninstall and API-key saves share the same durable per-harness
writer marker. A restart, expired receipt or failed launch acknowledgement does
not prove the writer stopped; only confirmed native cleanup releases admission.

All new routes are private. Authorization is the authenticated selected runtime
owner; a shared-chat collaborator cannot grant native provider access.

| Route | Method | Public | Authority and effect |
| --- | --- | --- | --- |
| `/api/ai/provider-settings/workflows/v2/capabilities` | GET | No | Runtime owner; qualified nonsecret provider/method discovery |
| `/api/ai/provider-settings/workflows/v2/start` | POST | No | Runtime owner; exact option and idempotency key; native writer admission |
| `/api/ai/provider-settings/workflows/v2/keys` | POST | No | Runtime owner; bounded transient key for exact registered provider option |
| `/api/ai/provider-settings/workflows/v2/:id` | GET | No | Runtime owner and operation scope; nonsecret receipt |
| `/api/ai/provider-settings/workflows/v2/:id/code` | POST | No | Runtime owner and exact active operation; single bounded completion |
| `/api/ai/provider-settings/workflows/v2/:id/cancel` | POST | No | Runtime owner; cancellation with native process drain |
| `/api/bot-connections` | GET | No | Runtime owner; current source eligibility and consent projection |
| `/api/bot-connections/:id/authorization` | POST | No | Runtime owner; revisioned connection consent and separate background consent |
| `/api/chat-agents/:agentId/execution` | GET | No | Owner of the Bot on the selected Computer; separate execution binding |
| `/api/chat-agents/:agentId/execution` | POST | No | Owner of the Bot; revisioned source/model binding to current consent |

V2 receipt identity includes the admitted connection option. Polling, code
submission, cancellation and recovery use the same underlying operation admission
and durable native-profile guard. A legacy client cannot accidentally select a
different provider because additional methods were registered.

| Boundary | Auth source | Validation and limits |
| --- | --- | --- |
| Capability/operation reads | Verified selected runtime owner | Strict bounded DTOs; private/no-store; collaborators denied with 403, missing auth with 401 |
| Login/key start | Runtime owner and writable profile authority | bodyLimit before buffering; strict option ID; installed protocol qualification; idempotency and native writer lease |
| Code/device completion | Exact live operation and owner/Computer | Single submission; reject expired/changed operation; fixed trusted authorization origins |
| OAuth registration | Exact issued client and attempt | PKCE/state/nonce; verify signed issuer/audience/identity and granted scopes |
| Bot selection/grant mutation | Existing owner Bot write authority | Nonsecret source/model/executor refs; revision-enforced transactional related writes |
| Every inference/task continuation | Current Bot grant intersected with current source/model/Computer | Revalidate before next call; finite timeout/output/tool bounds; cancellation drain; no cross-source fallback |
| Disconnect/cancel | Exact scoped owner connection/operation | Fence continuations; await actual native cleanup; preserve uncertain effects |

Credentials never enter renderer DTOs, model context, worker environment or logs.
Owner-controlled trusted native custody remains the source of truth. API probes
use fixed non-billable origins, explicit timeouts and redirect rejection. Failed
replacement preserves the old profile; a credential saved before route activation
fails remains recoverable and is not reported as rolled back.

Maintain current operation TTL/count/rate/queue/native deadlines. More providers
must not create unbounded probes or registries. Drain on shutdown. Protect native
writer admission across restart until real process exit/cleanup is confirmed.

## Bot and Chat UI

Direct Pi configuration chooses Connection then Model from the current source
catalog. Keep one shared derivation in Bot creation/editor and relevant Chat
surfaces. Unconnected selections open Settings and preserve the unsent draft.
Automatic remains available for Matrix funding and genuine owner API keys. It
must not directly consume native Claude or Codex subscription credentials, or
expand into cross-source paid fallback. The legacy `MATRIX_BOT_CODEX_MODEL`
override fails closed until the separate Matrix ChatGPT route is qualified.

Claude Code is an explicit Task executor, not a direct Pi subscription model row.
Child session/resume, permissions, approved tools, cancellation and result
provenance are visible and distinct. Bot grants remain the ceiling for Integration
and MCP tools, including Supervised and one-use decisions.

Execution bindings are separate from the strict legacy Chat agent DTO. Bot
creation preserves the created Bot if executor configuration fails and retries
only that configuration. Connection consent is stored per owner and Computer;
the Bot binding records the consent revision. Native identity changes or revoked
consent prevent subsequent calls. The Pi coordinator's selected funding source
remains explicit and separate from the Claude task executor's subscription.

Both native app-server ChatGPT login in hosted Matrix and the direct ChatGPT
connection remain unavailable with `provider_access_required`
until Matrix's own registered client and deployment eligibility are qualified.
It has no selectable models, grant action or borrowed Codex credential path.

The closed Chat provider control owns initial loading. Opening or reopening the
model popup reuses that scoped catalog and does not autofocus Search. Actual
account, runtime and accepted Settings mutations invalidate the proper cache.
Cached display state never authorizes execution.

Shared semantics apply to Web Desktop, Electron Desktop and Web Canvas, and
applicable mobile surfaces. Presentation layout may adapt.

## Implementation boundaries

Extract provider-workflow registration from the large gateway server and split the
shared workflow panel before adding behavior. Keep provider-specific qualification
and savers in focused modules with dependency injection. Preserve ordinary native
chats, owner data, disabled intent and Matrix-funded Pi behavior. Do not merge old
draft stacks or infer cross-provider memory import support.

## Acceptance

1. Each advertised option invokes the matching provider saver and current catalog;
   unknown, stale, cross-owner and uninstalled combinations cause no effects.
2. Valid authorization avoids repeat login. Failed replacement, delayed completion,
   cancellation, expiry and restart preserve native-profile admission correctly.
3. Settings and Bot drafts survive approval, account change and Computer switching.
4. New and existing eligible Bots produce visible text and tool continuation,
   preserve confirmed memory/history, resume and stop without orphan writers.
5. Integration/MCP requests preserve grant intersections, decline/one-use approvals
   and completed effect checkpoints. No SDK-wide permission bypass.
6. Quota/revocation cannot charge another source or replay an uncertain effect.
7. Exact source/client/runtime provenance and real Electron Desktop with a matching
   scoped VPS are recorded separately from fixture/contract results.
8. Fresh required CI and Greptile 5/5 are required before any authorized merge.

Unavailable real credentials are explicit acceptance gaps; synthetic success is
not a live subscription execution claim. Restricted or unapproved direct routes
are deferred scope, not advertised promises or blockers for otherwise complete
permitted native delivery.

## Native status and legacy workflow regression contract

Native Claude qualification checks version and required CLI flags independently
from authentication. `claude auth status --json` may return a valid logged-out
object with exit1. Parse only bounded structured output: explicit logged-out status
maps to `authentication_required` and connect-first UI; missing executable/flags,
timeouts, malformed protocol and unexpected exits remain unavailable. Never infer
authentication from stderr or grant Bot access from credential presence alone.

A legacy fixture that does not implement V2 returns404 at absent V2 workflow
routes. Product clients retain strict response validation: malformed200 is an
error, not permission to fall back or authenticate. Cover connected/logged-out
status, malformed/timeouts, legacy browser completion/cancellation/disconnect and
late account/Computer changes with focused regressions and real Electron tests.

## Executable contract: native CLI and hosted integration boundaries

The detailed signatures, authority matrix and validation requirements live in
[codex-dual-entry.md](./codex-dual-entry.md). Backend and shared UI admit the
qualified current `openai_device_code` Codex subscription option and explicit
`openai_terminal` fallback. Browser, legacy and unqualified methods remain
unavailable. Direct Settings starts use the same native
owner/harness/profile authority. Existing accounts are preserved and cannot be
silently replaced by an official CLI command that clears credentials before consent.

Private completion requires exact fresh independently verified native identity,
serialized source/account selection, revision checks and compensation. Completion
replay respects subsequent owner Off. Native launch, continuation and steering must
recheck exact authority; revocation cannot target a replaced principal. Native
subscription execution cannot inherit a key/funded fallback or Matrix AI grant.

Tests cover current terminal handoff, stale embedded methods, readonly owners,
existing accounts, exact completion, identity drift, native lifecycle isolation,
and no-fallback child execution. Real Electron Desktop and selected Computer
acceptance remains distinct from fixtures. API-key and Claude native behavior
remain compatible.

Official sources distinguish [owner CLI remote/headless login](https://learn.chatgpt.com/docs/auth#login-on-headless-devices)
from [app-server authentication](https://learn.chatgpt.com/docs/app-server#auth-endpoints).
The CLI route does not confer permission to implement an otherwise excluded
hosted OAuth service. Matrix SIWC registration is not a universal prerequisite
for an owner's official CLI login.

## Deferred scope

Google/Gemini, Z.ai/GLM, DeepSeek, further OpenRouter expansion and new OpenClaw
behavior need the same qualification before later addition. Hosted Codex app-server subscription authentication, restricted direct
Claude subscription inference and unapproved Matrix SIWC are not implemented.
Arbitrary verifier URLs, subscription resale/pooling, new memory-import design and
fleet deployment are outside this PR. Public documentation in the private site
repository remains paused at the owner's request.
