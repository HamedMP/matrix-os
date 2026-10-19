# Starter compute through Matrix AI Gateway

[ENG-319](https://linear.app/matrix-os/issue/ENG-319/ship-shared-workspace-alongside-personal-vps-runtimes). The requester selected the Matrix AI gateway for the two-owner Starter pilot after confirming the saved desktop opens. Product/engineering review of the runtime authority and accounting changes is recommended. This extends the existing native stack after the frozen Starter picker layer.

## Outcome and boundaries

Hamed and Nima keep their existing VPS computers and selections. Their isolated Starter workers obtain separately owner-bound Matrix AI access, execute real background tasks, checkpoint, stop, and resume without a personal Anthropic key. The current preview labels for unavailable live Chat/Terminal remain accurate. No public signup, personal-runtime credential reuse, production traffic change, or stack merge is included.

The existing SDK harness cannot use a relay URL alone: its normal kernel credential path intentionally rejects ambient or Matrix-funded credentials. Normal funded Matrix agents use a managed worker that requires a separate supervisor/sandbox not present in the Cloudflare image. The pilot needs an explicit reviewed compatibility adapter for its existing per-owner Cloudflare isolation boundary; it must not restore a global funded-SDK fallback or mislabel a relay lease as an owner API key.

## Authority and data

- Use a dedicated pilot platform database, initialized from a bounded two-owner metadata snapshot. Never migrate or add shared-runtime rows to the existing shared preview's database while its older image serves traffic. Give each actual owner-bound Worker a distinct logical `shared-preview` runtime identity in that isolated platform. It is neither a customer VPS nor a native computer. Its availability describes the durable Worker, not an awake Linux container. Enforce owner/source/handle uniqueness and expiry. Existing computer inventory and default personal routing must exclude this class.
- Reuse the platform's runtime verification, opaque short-lived AI credentials, owner policy, credit reservation, settlement and revocation. Each identity has an explicit small test allowance/model policy; an allowance for compute is separate from inference credit. No customer/VPS token is borrowed.
- Inject only that runtime's verification authority into its isolated runtime; the agent receives a short-lived relay credential. Central Cloudflare/relay control credentials stay on the relay/platform. Do not persist credentials in the image, saved files, checkpoint or client response.
- Add a trusted programmatic kernel-credential seam for the isolated gateway harness. Its default keeps existing personal SDK rejection unchanged. The compatibility adapter obtains and validates a bounded Matrix lease for the exact runtime/model and background class, supplies the fixed relay URL, observes expiry and abort, and closes resources at drain.
- A dedicated zero-default-traffic relay tag uses the existing immutable relay image and preview Cloudflare gateway, with the isolated staging platform as its policy authority. Keep production and shared preview relay traffic/configuration unchanged. Do not point a staging-issued credential at the production policy database.

| Boundary | Authority and limits |
| --- | --- |
| Web task/wake | Existing verified Clerk owner, exact private Starter registry, existing admission and generation fencing |
| Worker credentials | Exact preview owner/generation, fixed server configuration, separate owner database and runtime identity; no browser-selected credential or URL |
| Runtime lease issuance | Existing runtime verification token, exact owner/machine/slot identity, expiry and bounded response |
| Inference | Opaque Matrix lease, exact model policy, owner credit reservation/settlement, fixed relay origin and server-set background class |
| Operator bootstrap | Trusted operator only; no new public registration/grant endpoint; staging database and explicit test window |
| Legacy personal routing | Existing customer/preview classes and routes; no implicit selection of shared metadata |

Account deletion fails closed while any shared Worker authority remains active. The pilot operator must first revoke policy, stop and verify Cloudflare compute, remove the owner Worker/storage/databases, and mark its logical record retired. The VPS adapter skips only already retired shared records; transactional metadata erasure cascades their bindings. Automatic Cloudflare account-deletion orchestration is deferred.

All external calls need timeouts, bounded responses and redirect rejection. Unknown/mismatched authority fails closed. A metadata row without a policy/credit grant is an acceptable inert orphan; incomplete setup must not enable paid work. Revocation or expiry denies subsequent inference while saved reads remain available. Existing uncertain-termination holds remain quarantined rather than refunded.

## Validation and delivery

1. Tests first: shared-runtime schema/registration and default-route exclusion; existing VPS identities still authenticate; wrong owner/slot/epoch is denied; default SDK funding remains rejected; explicit adapter gets the correct lease without owner-key persistence; no credential leakage; expiry, abort and failed settlement remain fail-closed.
2. Reuse the stack ticket and publish the added layer separately from the frozen nine reviewed heads. Require current-head 5/5 and full CI. Update the separate public docs PR for the bounded gateway pilot.
3. Bootstrap and deploy only the two test owners and dedicated tags. Verify the existing computer inventory/default traffic before and after. Start with bounded requests and record exact source/image, per-owner reservation/settlement, timings and actual inference cost.
4. Qualify two-owner reads asleep, real task output, tool wait across browser disconnect, checkpoint/destruction and continuation, exhausted/expired allowance denial and cross-owner isolation. Capture current Web Desktop/Canvas/Mobile and the shared Help correction's Electron evidence. Missing surface access remains a review gate; do not infer captures from API results.
5. Stop and verify owned test compute at the end; retain only the explicitly requested pilot resources with named retention/cleanup ownership. Disable expired test policies and remove only temporary credentials/resources. No Slack sharing or merge is authorized.

## Protocol and pricing qualification

The actual pinned SDK was probed against a local synthetic Anthropic SSE responder. Its Messages payload passes the existing funded relay serializer, and its seven requested beta headers are already included in the deployed preview relay's explicit ten-value allowlist. The synthetic response is a wire-compatibility probe, not paid inference or agent qualification. The test relay tag must retain that explicit reviewed list; no wildcard beta or global policy expansion is needed.

The inherited Sonnet pricing review expired on 2026-10-15. On 2026-10-19 the official [Cloudflare model page](https://developers.cloudflare.com/ai/models/anthropic/claude-sonnet-5/) and [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) were checked before renewing only the pilot tag's bounded review window. The configured version remains `anthropic-2026-08-31-standard`; rates must still match input $2, output $10, cached input $0.20, five-minute cache write $2.50 and one-hour cache write $4 per million tokens. No rate change or production review renewal is included.
