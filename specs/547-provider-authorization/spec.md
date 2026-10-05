# Complete provider authorization

Tracking: ENG-117. Approved implementation scope: 2026-10-05.

## Outcome

Settings exposes the actual supported account and key connection methods for Codex,
Claude Code, Hermes, Pi, OpenCode and OpenClaw on the selected Computer. Selecting a
provider binds that provider to validation, native persistence, readback, catalog
and execution admission. A connected native account, permission to use it in Bots
and an executable model route remain separate observations.

The first fixed API-key provider set is OpenAI, Anthropic and OpenRouter, wherever
the installed harness has a verified saver and catalog. Codex uses OpenAI; Claude
Code uses Anthropic. Additional providers use the same qualified registry rather
than arbitrary URLs, commands or claimed upstream support.

## Authorization and execution sources

| Source | Execution | Eligibility |
| --- | --- | --- |
| Matrix AI credit | Existing private Pi inference broker | Preserve current funded admission and model proof |
| Owner API key | Qualified native harness or explicit Pi broker route | Fixed provider, current credentials, catalog and exact owner selection |
| ChatGPT subscription for native Codex | Official Codex login | Existing native authorization is reusable on the same Computer |
| ChatGPT subscription for Matrix Pi | Matrix registered Sign in with ChatGPT adapter | Own issued client and confirmed deployment/access eligibility; native Codex login alone is insufficient |
| Claude subscription for Bot tasks | Unmodified official Claude Code child executor | Existing end-user native login, explicit Bot grant and scoped child authority |
| Claude subscription for direct Pi inference | Unavailable by default | Requires separate provider permission |

Never silently fall back to Matrix credit, another account or another source.
Subscription usage is not a fabricated USD balance. Any Pi coordinator inference
has its own explicit funding source.

## Connection workflow

Connect opens a provider and method chooser from a bounded server catalog. Already
valid authorization is reused for the exact permitted consumer. Missing Matrix app
consent or Bot permission asks only for that missing step. A login on another
Computer or in the provider's website does not establish runtime authorization.

Use existing account cards, verified identity and supported Connect/Reconnect/
Change account actions. Ordinary setup does not require saved-account management
or advanced configuration. Subscription allowance/reset appears only if observed;
otherwise show Usage unavailable. A supported native TTY login opens the canonical
Terminal with visible progress and cancellation; unqualified methods remain
unavailable with a safe explanation.

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

The direct ChatGPT connection remains unavailable with `provider_access_required`
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

External registration/access or unavailable real credentials are explicit
acceptance gaps; synthetic success is not a live subscription execution claim.
Provider access is disabled until the required eligibility is confirmed.

## Deferred scope

Google/Gemini, Z.ai/GLM, DeepSeek and further providers need the same qualification
before addition. Direct Pi Claude subscription requires separate permission.
Arbitrary verifier URLs, subscription resale/pooling, new memory-import design and
fleet deployment are outside this PR. Public documentation in the private site
repository remains paused at the owner's request.
