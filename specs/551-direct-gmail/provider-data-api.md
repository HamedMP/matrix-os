# Google-data authority boundaries

ENG-355; companion to provider-data-controls.md. All new handling remains disabled until runtime composition and qualification are complete. The profile registry has no user-facing review/approval endpoint. Actual account terms/settings remain operator evidence, not code defaults.

| Route relative to `/api/integrations` | Authority | Behavior |
| --- | --- | --- |
| `GET /gmail/processing-profiles?connectionId=…` | Verified owner; exact owned Gmail connection | Safe current disclosures and consent revision; no collection or permission grant |
| `POST /gmail/processing-consents` | Verified owner; exact owned Gmail connection; explicit affirmative action; current profile/evidence/disclosure/retention revisions | Revision-conditional consent; 4 KiB body; no route self-approval |
| `DELETE /gmail/processing-consents/:connectionId` | Verified owner; exact owned Gmail connection | Revoke all processing consents for that account; 1 KiB body including ignored streaming bytes; does not attest content deletion |
| `POST /gmail/processing/authorize` | Platform-verified machine bearer AND signed owner delegation; authoritative user mapping; exact active Gmail account | Resolve the exact observed transport against one reviewed profile; return current authority or safe consent-required disclosure; 16 KiB body |
| `POST /gmail/processing/revalidate` | Same machine/owner/account boundary; exact original stamp and observed transport | Recheck durable authority without changing the original grant; 16 KiB body |

These routes expose neither credentials, fingerprints, private endpoint/account mappings nor raw provider errors. Responses are not cached. The host must supply verified owner resolution and connection ownership; metadata permission does not imply collection, bot grants or write approval.

The machine processing envelope binds owner, run/runtime generation, profile/consent revisions, exact Google account, purpose and route digest to exact method/path/body bytes. Its maximum lifetime is 30 seconds and never exceeds policy expiry. Signatures are domain-separated, compared in constant time and stripped from untrusted proxy requests. Verification alone is insufficient: composition must revalidate current policy/run authority and consume each request ID once before dispatch. No model receives signing keys or envelopes. This protocol is not yet active in a deployed runtime.

The integration database migrates a bounded PostgreSQL replay ledger and starts its cleanup even while new Gmail handling is disabled. Accepted IDs remain consumed until expiry plus five seconds; expired envelopes remain invalid after metadata cleanup. Shutdown drains ledger work before its host closes the shared pool. This ledger does not independently prove signatures, live runs or current consent.

The current observed-transport adapter can resolve the owner Anthropic API credential generation. Managed Cloudflare resolution still requires a stable, reviewed downstream descriptor; temporary relay-token fingerprints are insufficient. Unknown managed, local, native or delegated routes deny Google processing. This does not claim that every provider has a working adapter.

Model dispatch accepts a server-owned policy authority. It checks actual resolved credential fingerprint, endpoint/model/API and harness version before each send/retry and before releasing the response. Google-bearing requests use strict transport configuration with no stateful/remote provider features, automatic prompt caching, request metadata or unreviewed headers. Business text/function results are data, not configuration. Ordinary non-Google traffic keeps its existing behavior. A missing composition cannot be represented as a qualified Google route.

The pinned Pi SDK wire is tested with an intercepted synthetic request. Its documented Anthropic ephemeral cache directives are removed only from typed system/message/tool configuration positions for Google processing; unknown cache controls still deny. Tool arguments, result text and JSON-schema property names are never scanned or rewritten as configuration. The current SDK's eager tool-input streaming flag is a typed boolean and does not add a processor or storage feature.

The oversized general call route is extracted into a focused handler before adding collection hooks. Optional trusted collection admission receives the exact canonical account for both direct and Pipedream Gmail. Its release check runs after provider and usage awaits; failures are generic and cannot cause a second lease settlement. Configured calls skip optional Gmail profile enrichment during inventory sync so it cannot precede admission. Internal token/credential waits require the transport's separate before-send guard; a route bracket alone is not proof of that boundary.

Funded Cloudflare relay requests explicitly bypass Gateway response caching on inference, token counting, readiness and evaluation paths. Payload logging stays disabled and generation billing receipts retain their content-free metadata. These request controls do not establish provider-side retention, account settings or historical-log deletion; those require separate operational evidence.
