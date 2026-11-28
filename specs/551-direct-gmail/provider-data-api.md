# Google-data authority boundaries

Platform startup keeps collection construction in focused adapter modules rather than adding processing logic to its oversized entrypoint. It installs the trusted factory only on internal integration routes, behind the existing machine bearer, signed-owner delegation and account-deletion mutation guard. Canonical integration user UUIDs map to Clerk owners; exact active Gmail connections are rechecked before each send and release. Internal native (direct OAuth) Gmail calls without a processing envelope fail closed, so platform rollout requires matching host signing and owner-consent support. Pipedream Gmail calls without a processing envelope keep their pre-existing behavior. Calls with an envelope use the same authenticated send and release checks as native calls. A missing or unrecognized stored identity stays admission-gated. Public owner inspection/export paths retain their own authorization and are not evidence of qualified public model egress.

ENG-355; companion to provider-data-controls.md. All new handling remains disabled until runtime composition and qualification are complete. The profile registry has no user-facing review/approval endpoint. Actual account terms/settings remain operator evidence, not code defaults.

| Route relative to `/api/integrations` | Authority | Behavior |
| --- | --- | --- |
| `GET /gmail/processing-profiles?connectionId=…` | Verified owner; exact owned Gmail connection | Safe current disclosures and consent revision; no collection or permission grant |
| `POST /gmail/processing-consents` | Verified owner; exact owned Gmail connection; explicit affirmative action; current profile/evidence/disclosure/retention revisions | Revision-conditional consent; 4 KiB body; no route self-approval |
| `DELETE /gmail/processing-consents/:connectionId` | Verified owner; exact owned Gmail connection | Revoke all processing consents for that account; 1 KiB body including ignored streaming bytes; does not attest content deletion |
| `POST /gmail/processing/authorize` | Platform-verified machine bearer AND signed owner delegation; authoritative user mapping; exact active Gmail account | Resolve the exact observed transport against one reviewed profile; return current authority or safe consent-required disclosure; 16 KiB body |
| `POST /gmail/processing/revalidate` | Same machine/owner/account boundary; exact original stamp and observed transport | Recheck durable authority without changing the original grant; 16 KiB body |

For consent mutations on the internal mount, the Platform verifies an independent
owner session. An in-chat grant can carry a Platform-signed approval that
attests to verified owner session provenance and binds the exact consent body.
The signed digest binds the account, profile, purpose, revisions, data kinds
and expiry. The consent transaction's revision check prevents accepting the
same decision again.

On Hosted Computer routes, the Platform edge issues a proof from the verified
personal owner's current session before replacing its credentials. It checks
the forwarded query after removing Platform routing parameters, including the
Additional Computer slot selector. Grant and revocation proofs expire within
30 seconds and bind the selected Computer and owner to the exact submitted
grant body or the revoked account. The Gateway relays each proof on its own
operation. Platform verifies it behind machine and signed owner-delegation
checks. A grant consumes the expected consent revision. Revocation consumes
its nonce in the same transaction as revocation and purge enqueueing.

These routes expose neither credentials, fingerprints, private endpoint/account mappings nor raw provider errors. Responses are not cached. The host must supply verified owner resolution and connection ownership; metadata permission does not imply collection, bot grants or write approval.

The machine processing envelope binds owner, run/runtime generation, profile/consent revisions, exact Google account, purpose and route digest to exact method/path/body bytes. Its maximum lifetime is 30 seconds and never exceeds policy expiry. Signatures are domain-separated, compared in constant time and stripped from untrusted proxy requests. Verification alone is insufficient: composition must revalidate current policy/run authority and consume each request ID once before dispatch. No model receives signing keys or envelopes. This protocol is not yet active in a deployed runtime.

The integration database migrates a bounded PostgreSQL replay ledger and starts its cleanup even while new Gmail handling is disabled. Accepted IDs remain consumed until expiry plus five seconds; expired envelopes remain invalid after metadata cleanup. Shutdown drains ledger work before its host closes the shared pool. This ledger does not independently prove signatures, live runs or current consent.

The current observed-transport adapter can resolve the owner Anthropic API credential generation. Managed Cloudflare resolution still requires a stable, reviewed downstream descriptor; temporary relay-token fingerprints are insufficient. Unknown managed, local, native or delegated routes deny Google processing. This does not claim that every provider has a working adapter.

Model dispatch accepts a server-owned policy authority. It checks actual resolved credential fingerprint, endpoint/model/API and harness version before each send/retry and before releasing the response. Google-bearing requests use strict transport configuration with no stateful/remote provider features, automatic prompt caching, request metadata or unreviewed headers. Business text/function results are data, not configuration. Ordinary non-Google traffic keeps its existing behavior. A missing composition cannot be represented as a qualified Google route.

The pinned Pi SDK wire is tested with an intercepted synthetic request. Its documented Anthropic ephemeral cache directives are removed only from typed system/message/tool configuration positions for Google processing; unknown cache controls still deny. Tool arguments, result text and JSON-schema property names are never scanned or rewritten as configuration. The current SDK's eager tool-input streaming flag is a typed boolean and does not add a processor or storage feature.

The oversized general call route is extracted into a focused handler before adding collection hooks. The trusted collection admission hook receives the exact canonical account for native Gmail and for Pipedream Gmail requests with an envelope. Its release check runs after provider and usage waits and settles the lease once. A denied read returns a generic error. When the provider has completed a write or destructive action, a denied release returns a content-free success receipt so callers can avoid repeating the mutation. Configured calls skip optional Gmail profile enrichment during inventory sync so it cannot precede admission. Internal token/credential waits require the transport's separate before-send guard; a route bracket alone is not proof of that boundary.

Funded Cloudflare relay requests explicitly bypass Gateway response caching on inference, token counting, readiness and evaluation paths. Payload logging stays disabled and generation billing receipts retain their content-free metadata. These request controls do not establish provider-side retention, account settings or historical-log deletion; those require separate operational evidence.

## Composed collection and contextual consent

The owner-tools adapter selects the immutable canonical connection ID, then calls the broker's collection preparer. Full-access chat permission never approves a new recipient/purpose notice. Only an authenticated canonical owner approval can accept the safe recipient, purpose, data-kind, retention and expiry disclosure. Exact profile/disclosure CAS checks follow that interaction; the claim stays in trusted server memory and is excluded from both tool JSON and model output.

The platform transport signs the exact serialized request bytes immediately before sending. It checks the claim owner, Gmail service, canonical account and fixed POST path. `collectionExpiresAt` separately bounds retained-context/source/pin deadlines while `policyExpiresAt` remains the original central stamp expiry. The envelope and replay ledger enforce the earlier deadline. Local in-process owner projection cannot silently downgrade a claimed request into unqualified machine authority.

The collection receiver issues distinct repeated `beforeSend` and exactly-once `release` checks. The former runs after token/refresh waits at each controlled Gmail HTTP send; request cancellation reaches the actual native Gmail fetch and streamed response. The latter runs after provider and usage waits before data release, including error settlement, with the completed-write exception above. Jev's repeated bounded reads of native Gmail receive the same pre-send guard; this does not qualify Jev onward processing.

Startup passes the same explicit API-key credential authority used by broker inference. The preparer revalidates, rereads the credential and revalidates again against a privately observed real SDK dispatch; it never guesses an endpoint or treats a temporary funded token as stable processor evidence. Shutdown cancels pending owner interaction and drains accepted database work. Managed relay proof, saved-copy adapters and all five live product surfaces remain separate unfinished qualification work. Existing Bedrock transport work is tracked in reference PR #2624 (ENG-150); Gmail must align with that implementation rather than duplicate its transport.
