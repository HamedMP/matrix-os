# Google-data authority boundaries

ENG-355; companion to provider-data-controls.md. All new handling remains disabled until runtime composition and qualification are complete. The profile registry has no user-facing review/approval endpoint. Actual account terms/settings remain operator evidence, not code defaults.

| Route relative to `/api/integrations` | Authority | Behavior |
| --- | --- | --- |
| `GET /gmail/processing-profiles?connectionId=…` | Verified owner; exact owned Gmail connection | Safe current disclosures and consent revision; no collection or permission grant |
| `POST /gmail/processing-consents` | Verified owner; exact owned Gmail connection; explicit affirmative action; current profile/evidence/disclosure/retention revisions | Revision-conditional consent; 4 KiB body; no route self-approval |
| `DELETE /gmail/processing-consents/:connectionId` | Verified owner; exact owned Gmail connection | Revoke all processing consents for that account; 1 KiB body including ignored streaming bytes; does not attest content deletion |

These routes expose neither credentials, fingerprints, private endpoint/account mappings nor raw provider errors. Responses are not cached. The host must supply verified owner resolution and connection ownership; metadata permission does not imply collection, bot grants or write approval.

The machine processing envelope binds owner, run/runtime generation, profile/consent revisions, exact Google account, purpose and route digest to exact method/path/body bytes. Its maximum lifetime is 30 seconds and never exceeds policy expiry. Signatures are domain-separated, compared in constant time and stripped from untrusted proxy requests. Verification alone is insufficient: composition must revalidate current policy/run authority and consume each request ID once before dispatch. No model receives signing keys or envelopes. This protocol is not yet active in a deployed runtime.

Model dispatch accepts a server-owned policy authority. It checks actual resolved credential fingerprint, endpoint/model/API and harness version before each send/retry and before releasing the response. Google-bearing requests use strict transport configuration with no stateful/remote provider features, automatic prompt caching, request metadata or unreviewed headers. Business text/function results are data, not configuration. Ordinary non-Google traffic keeps its existing behavior. A missing composition cannot be represented as a qualified Google route.
