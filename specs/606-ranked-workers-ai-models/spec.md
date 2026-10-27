# Ranked Workers AI models

Track: [ENG-296](https://linear.app/matrix-os/issue/ENG-296/featai-add-ranked-cloudflare-workers-ai-models), readiness [ENG-205](https://linear.app/matrix-os/issue/ENG-205/matrix-ai-is-unavailable).

## Outcome and scope

Add eight Workers AI models: DeepSeek V4 Flash 0731 and V4 Pro 0813, GLM 5.3, Kimi K2.7 Code, GPT-OSS 120B and 20B, Gemma 4 26B A4B, and Qwen 3.8 27B. Keep GLM 5.3 Flash as the default. Selection uses exact Cloudflare IDs; DeepSeek V4.1 Flash is a different model and is not included. OpenRouter's [weekly rankings](https://openrouter.ai/rankings?view=week) measure token traffic, not quality. Flash is third; the DeepSeek Flash 0731 and full GLM additions are ninth and tenth as of October 14, 2026. Artificial Analysis [compares](https://artificialanalysis.ai/models/comparisons/glm-5-3-flash-vs-glm-5-3) Flash at 42 versus full GLM at 45 on its intelligence index, with full GLM roughly nine times the token price. Flash is the economical default, not a universal quality winner.

All model choices flow through the shared V3 catalog for Web Canvas, Web Desktop, Electron Desktop, Web Mobile and Native Mobile. Ordinary Chat and Matrix Bot use the same Pi/OpenCode managed route. Existing saved routes and owner credentials are preserved. No third-party Gateway providers, automatic routing or new credentials.

## Route and funding invariants

| Existing endpoint | Authentication | Exposure |
|---|---|---|
| Relay `/v1/chat/completions` | Scoped, expiring Matrix credential plus authoritative owner/model policy | Authenticated |
| Relay `/ready?model=…` | Relay control credential | Internal |
| Platform runtime funding/readiness | Owner runtime token, identity and epoch | Internal |
| Gateway provider Settings/Chat catalog | Existing gateway auth | Owner |

A bounded shared allowlist owns exact model IDs, labels, context limits and supported reasoning. Request serialization rejects unsupported model/effort combinations before admission; URL construction permits only reviewed IDs. Provider responses must match the requested model and include valid final usage. Preserve bounded streams, cancellation, owner-scoped atomic holds, one funded request in flight, exact response settlement and unresolved fail-closed outcomes. Prices are immutable snapshots with separate expiring operator attestations, never rolling startup deadlines.

Cloudflare prices verified October 14: DeepSeek $0.44/$1.32 per million input/output tokens, $0.014 cached input; GLM $1.40/$4.40, $0.26 cached input. Verify again at release against the official model pages and live account catalog.

## Readiness and rollout

Live GLM generation can take 21.4 seconds. Permit a bounded 25-second upstream probe, with ordered margins through the renderer (27/29/30/31/32 seconds). Do not extend policy freshness or credentials. Expired evidence, disabled policy and failed probes remain unavailable. One model's success cannot enable another model.

Enable new policy entries only after Relay, Platform and customer runtimes support the new catalog. Old runtime receipt parsers allow at most two ready IDs; update those runtimes before broadening policy. Older Electron builds keep their shorter deadline until a reviewed desktop release. Operator probe budgets must accommodate all enabled models; the current two-per-minute budget cannot supply ten simultaneous fresh receipts. Do not lift limits or redeploy as an investigation shortcut.

## Acceptance and deliverables

- Failing tests first: exact model routing, denied unknown IDs, effort validation, immutable pricing/review expiry, fractional cached pricing, bounded usage and shared readiness/catalog/worker contracts.
- One bounded live streaming spike per addition; verify model and final usage metadata without recording prompts, response text or secrets.
- Reviewed test runtime: successful funded Chat and Bot requests per addition; ledger settlement, revocation and stale evidence remain correct. Validate Web Canvas, Web Desktop, Electron Desktop, and relevant mobile catalogs; capture live screenshots/recording before review readiness.
- Separate documentation PR in `FinnaAI/matrix-os-site` for supported managed models and funding behavior.
- Suggest affected users review the model names, prices and availability journey before rollout; approval becomes a gate if requested.

## Risks and deferred work

Production enablement follows PR review and validation; local tests and direct Cloudflare spikes do not establish end-to-end customer readiness. No credit grants, IAM changes, alternate routes or resets. Settings mount-time snapshot refresh and canary artifact signing remain separate issues. Larger orchestration files receive only delegation changes; model behavior stays in focused helpers.

## Approved scope and model-specific boundaries

Owner approved all eight additions and retaining Flash as default on October 15. The customer fleet repair is separately tracked by ENG-205; never copy another owner’s credential. Inventory active eligible customer primaries first, then staged identity/epoch-bound atomic reconciliation with writer/idle guards, backup and rollback. Ineligible/deleted/busy/unsupported hosts are skipped with explicit outcomes. No credit grant or IAM change.

Qwen requires a genuine `max_completion_tokens` bound; never send its unsupported `max_tokens` alias. GPT-OSS supports low/medium/high; GLM supports low/high/max; DeepSeek additionally supports none. Kimi/Gemma accept no unreviewed effort override. Prices use integer thousandths of microusd so DeepSeek's $0.014 cached-input rate remains exact. Existing settlements keep their original pricing version. Price attestation and model policy remain release gates.

Eight additions increase worst-case paid health fanout. Keep shared probes coalesced and bounded; configure an explicit reviewed fleet probe allowance for the enabled model count rather than silently bypassing limits. Test partial health and per-model revocation, and preserve GLM Flash preference when ready.

## Operator configuration and rollout checks

### Existing customer policy alignment

Publishing a global funded-model policy through the existing operator endpoint must
also append its enabled ordinary model IDs to every existing authorized, nondeleted
customer runtime policy in the same transaction. Ordinary means Sonnet plus the
reviewed Workers AI registry; global publication remains an explicit operator
action after route support and readiness qualification. The registry alone does
not activate a model. New customer activation uses this same ordinary-model list.

Keep existing model order and additional explicit permissions, including Jev and
funded-native models. Do not automatically grant those specialized permissions.
Preserve enabled state, budgets, expiry, cooldowns, owner/runtime binding, balances,
holds, freezes, debt, usage and every ledger entry. Suspended, failed and secondary
customer runtimes with an existing policy receive the same list alignment while
retaining their lifecycle/access restrictions. Do not create missing policies or
modify Preview, Private Preview, unauthorized, deleted or mismatched records.

Only changed runtime lists increment their revision. Retrying an already-aligned
global list leaves runtime policies unchanged. Global revocation remains effective
through the existing global/runtime intersection even if the runtime retains an ID.
Global revision conflicts, lock/deadline failures, corrupt data or a merged list
exceeding the 64-model contract must roll back the entire global publication and
alignment. Return only aggregate alignment state; do not load the fleet into an
unbounded application inventory. Global policy writes and dependent alignment must
stay within one bounded transaction so concurrent publications cannot split them.

Verify with existing-customer, restricted-policy, exclusion, no-op, rollback,
revocation and competing-publication tests on PostgreSQL. The operational backfill
must record a private before/after policy and funding comparison, then independently
query for remaining missing ordinary IDs. Catalog API observations establish model
visibility separately from paid request/settlement acceptance.

The eight new immutable snapshots can be attested together with `MATRIX_FUNDED_WORKERS_PRICING_REVIEW_VERSION=cloudflare-2026-10-15-workers-eight`, canonical UTC `MATRIX_FUNDED_WORKERS_PRICING_REVIEWED_AT` and `MATRIX_FUNDED_WORKERS_PRICING_VALID_THROUGH` (at most 31 days). Omission keeps all eight expired. Existing Flash/Sonnet reviews remain independent. Per-model reviews remain supported; duplicate bundle/per-model entries fail startup. Cloud Run workflow validates the optional bundle before authentication and omits unset bindings.

Ten enabled text routes require a reviewed health budget that admits a complete cold fanout; shared healthy receipts are reused for five minutes across replicas. Proposed feature allowance: 20/minute and 3,000/day, under existing caps, with usage counters preserved. Current-day budget rows require explicit coordinated limit migration or next UTC-day activation; changing environment limits alone cannot override the pinned same-day limits. Do not reset counters. Monitor global probe counts, timeout/invalid-response outcomes, reservation finalizations and per-model availability during staged activation. Roll back new policy entries first if settlement or availability is incorrect; retain every admitted reservation's pricing version.

Gemma's live Workers API reports one internal model alias (`@cf/google/gemma-4-26b-a4b-it-external`). Accept only this exact requested/response pair and canonicalize it before client delivery and usage tracking. Other model mismatches fail closed. No generic suffix allowlist or alternate endpoint is introduced.

Generated Pi thinking-level maps and OpenCode variants expose only reviewed effort settings. Kimi/Gemma preserve reasoning parsing while omitting unsupported effort parameters; a stale requested Pi level clamps before Relay serialization. The real Pi SDK is verified using synthetic transport; a bounded OpenCode bootstrap spike made no inference requests, so actual OpenCode wire acceptance remains a release check.

Bot keeps Flash first and may use another exact ready Workers model when Flash is unavailable; explicit Chat selections never silently fall back. Credit history consumes shared model labels. Platform policy updates and persisted reads accept the same finite Workers registry and continue denying unreviewed `@cf/` IDs. Checkout needs only one healthy route: start the preferred route, hedge a second within 100 ms and the remaining deadline, advance failed candidates lazily with at most two concurrent probes, cancel on completion, and recheck current owner policy and ledger before success.
