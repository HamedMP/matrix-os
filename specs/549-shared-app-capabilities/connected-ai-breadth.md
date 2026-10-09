# U7: Connected AI completion adapters

The original request includes apps using any connected AI. Verified tool-free
execution is required; a Chat login alone is insufficient authority. U4's initial
static-key adapters established the contract. Unverified CLI adapters were removed.
OAuth and additional native profiles use their account coordinators rather than
copied credentials.

## Goal and boundaries

Extend the same exact owner/app/account/access-source/model contract through
verified existing completion primitives. No unrestricted agent runs, credential
copies that lose refresh updates, alternate-account fallback, or manufactured
readiness. Each adapter must refuse unsupported runtime versions/configurations.
Managed funding continues to use existing admission and settlement.

## U7a: Pi connected OAuth and exact model configuration

Inspect the installed public Pi ModelRuntime.completeSimple API and AuthStorage
refresh lock before design. Prefer no-tools SDK inference over copying OAuth into
scratch. Reuse generic-native-writer durable admission, exact owner route
revalidation and safe account/profile bindings. Load only trusted installed SDK
code, no owner extensions/hooks/MCP/context. Keep credentials in the runtime.
Test OAuth refresh coordination and exact selected provider/model, tools absence,
revocation, abort/output bounds and loader/version failure. A local stub provider
may verify SDK behavior without paid inference or customer credentials.

## U7b: Other connected sources

Verify paired ChatGPT-plan authority, OpenCode, Codex, Hermes and OpenClaw
primitives individually. Reuse observe/resolve/revalidate/infer authority for a
secretless text-only paired source only after canonical V3 projection. Native
profiles must coordinate account changes and prevent tool/context access. Record
concrete version/protocol blockers rather than promise unverified support.

## Execution ownership

The U7 worker initially owns new app-ai adapter modules and focused new tests only.
The review fixer exclusively owns edits to existing U1-U6 source during its pass.
Composition and catalog integration occur after that pass, with explicit file
ownership handoff. Test before implementation, independent review and required
checks before the implementation PR. Public docs must reflect final supported
routes and explicit limitations.

## Verified U7 result and remaining boundaries

U7a uses the installed Pi 1.0.4 public `ModelRuntime` inference API and the fixed
same-version native auth lock backend. A real installed-SDK test uses temporary
synthetic credentials and stub HTTP only: OpenAI and Anthropic payloads contain no
tools; two worker processes refresh one rotating grant once; cancellation waits
for rotated-grant persistence. Discovery batches at most 256 physical models per
owner native provider and never exchanges OAuth. Exact fixed grants are filtered
before probes. Unsupported SDK versions, virtual models, executable credentials,
auth/header overlays, unsupported protocols and unapproved endpoints fail closed.
A failed SDK discovery leaves unrelated routes usable; no Pi CLI fallback is permitted.
An inference failure never selects a second executor or account. A per-run worker
drain receipt follows settled credential work; missing receipt after crash/signal
or an uncertain mutation failure retains the owner writer fence. Supported no-tool API protocols are
`openai-completions`, `openai-responses`, `openai-codex-responses`,
`anthropic-messages`, and `mistral-conversations`. The worker's explicit HTTPS
endpoint allowlist is the authoritative app subset of the wider Pi catalog.

Paired ChatGPT is implemented through common V3 observation/projection and the
existing secretless owner device authority. The app selection carries the exact
account, source and model; execution rechecks the live grant revision and device
binding before and after text-only inference. This supports connected ChatGPT
subscription inference without borrowing a native Codex auth file. Portable
Pi/OpenCode Matrix-funded selections remain on the exact canonical managed
source/model policy and existing metered HTTP admission, rather than native auth.

The remaining native routes have specific implementation boundaries:

| Route | Evidence and current blocker | Smallest verified direction |
| --- | --- | --- |
| Native OpenCode static-key and OAuth completion | `packages/gateway/src/ai-providers/opencode-settings-auth.ts` exposes only bounded auth/health operations on its isolated local server. Installed 1.16.0 help confirms `--pure`/agent flags, but the isolated synthetic local-server no-tools audit produced no inference/completion within 30s even with model downloads/plugins/external skills disabled. The unverified static CLI executor was removed; flags alone are not readiness. A scratch copy loses rotating OAuth updates; pointing the entire data directory at the owner's directory also exposes native sessions. There is no verified selected-auth-only completion/refresh seam in that adapter. | Verify the exact pinned static-key no-tools protocol first, then extend the native auth coordinator with a documented isolated completion/refresh transaction, proving exact selected auth, refresh persistence and zero tools against a pinned OpenCode version. Reuse the generic writer fence. Do not copy refresh tokens into disposable scratch or use the general Chat session. |
| Borrowed native Codex subscription | `packages/gateway/src/collaboration/codex-owner-identity.ts` has an exact-account HTTP identity/refresh helper, but `packages/gateway/src/bots/broker-inference.ts` explicitly excludes borrowed native profiles from inference and reserves them for task execution. The installed `codex exec` flags offer read-only sandboxing, which still permits reads; they do not provide a verified global no-tools completion flag. | Prefer the implemented paired ChatGPT authority. A distinct native app source requires explicit account/source policy and coordinated identity refresh before using a fixed text-only HTTP adapter; do not launch read-only Codex agents as completions. |
| Hermes static key with verified model mapping | `hermes-credential-proof.ts` proves the exact native source/default profile and rechecks its files and live catalog around bounded provider metadata lookup. `hermes-model-proof.ts` resolves and pins an attested executable model before inference; OpenRouter requires its permanent canonical slug to be the API request ID with the exact pricing variant. `hermes-http.ts` accepts only preverified response IDs and retains the shared Settings writer fence through actual cancellation. | Synthetic profile/metadata/transport regressions cover Anthropic/OpenAI/OpenRouter mappings, exact snapshots, wrong models, pricing variants, retirement, revocation, stale evidence renewal and uncertain cancellation. Discovery verifies each exact model and preserves later active selections. Low-level Codex SSE tests exercise wire parsing only; they do not establish a runnable Hermes ChatGPT route. |
| Hermes ChatGPT, unresolved aliases, expiring OAuth, multiple accounts or custom transport | Native ChatGPT model slugs and fresh grants do not attest immutable snapshot mapping, so Hermes ChatGPT completion is unavailable before inference. Unresolved OpenAI aliases, unattested OpenRouter API IDs/variants, ambiguous pools, named profiles and credential/endpoint overrides also fail before paid calls. The separately authorized paired ChatGPT adapter is independent. | Follow-up ENG-201 / GitHub #2350: verify exact snapshot authority and coordinated account refresh before widening availability. Do not guess aliases or pricing suffixes, export refresh tokens, rotate accounts, or treat a native model catalog as proof of completion identity. |
| OpenClaw native profiles | `packages/gateway/src/chat/openclaw-provider-adapter.ts` calls the owner `agent` RPC with provider/model/session identity; it has no verified tools/context deny fields. The catalog/config adapters expose readiness and auth metadata, not a selected-credential completion API. No installed OpenClaw executable was available for a no-tools protocol spike. | Verify a pinned isolated profile/RPC protocol that proves empty tools, no owner context and exact account coordination, or a fixed credential-only HTTP adapter. Existing owner-agent RPC must remain unavailable to app text completion. |

These are provider/runtime protocol and account-authority boundaries, not client
surface omissions. Every surface shares the available/unavailable route result.
The follow-up implementation should land each verified primitive with an exact
installed-runtime spike, cancellation/refresh tests and truthful catalog changes;
connecting an account alone must never manufacture app completion readiness.

## Composition extraction

Connected app integration registration, AI executor creation and shutdown drains
move into `packages/gateway/src/server/app-capabilities.ts`. The gateway entrypoint
only supplies typed runtime dependencies and invokes registration/close; no app
policy or executor lifecycle logic is added to that large file. Subscription
observation also comes from the focused composition module. Keep the entrypoint
below 2,000 lines and continue extracting unrelated setup in future changes.
