# Ordinary Chat usage: operation and release qualification

Tracking: [ENG-355](https://linear.app/matrix-os/issue/ENG-355/prepare-gmail-oauth-verification-and-casa-evidence). See [requirements](ordinary-chat-analytics.md). This layer does not approve a Gmail processor or enable Google-data inference.

## Actual scope

The shared bot/managed Pi inference broker captures an immutable bounded ordinary-chat excerpt only after provider admission. An opaque process-private receipt binds owner, chat, run, runtime, execution generation and request. Completion follows successful response EOF and release checks. External coding-agent harnesses do not use this hook and are outside the report. The classifier sees only plain user/assistant messages from the admitted inference body, with no system text, tool schemas, attachments, owner identifiers or later history loads.

Task family/type and complexity are fixed estimated labels. Model, harness, access source, token counters and latency come from trusted broker bindings and validated observed responses. Cost is currently unknown in this hook: no price or settlement amount is inferred from text, model identity or worker metadata. The existing credit ledger remains the billing authority. An optional model confidence self-report is not a quality metric and is neither displayed nor aggregated.

## Activation and owner controls

`MATRIX_CHAT_ANALYTICS_ENABLED=true` enables host availability. It defaults off. An exact configured personal owner, owner PostgreSQL database and existing Matrix-funded credential provider are also required. Availability alone does not enable an owner policy.

Settings → Agents & providers → Chat usage shows the recipient/model, sampling, Matrix AI credit use and data handling. Enabling or updating requires affirmative `chat-usage-v1` disclosure acknowledgement. Initial sampling is 10%; the UI also offers 25% and 100%. Stopping first rotates/denies durable admission and then cancels queued/in-flight work, retaining reports. Confirmed deletion cancels work, removes policy/metadata, and leaves collection off. Actual Chat deletion cascades its metadata and cancels the matching in-memory work. No operation recalls requests already sent or deletes separate provider/backup records.

| Route | Method | Authority and payload |
| --- | --- | --- |
| `/api/chat-usage/policy` | GET | Existing authenticated JWT/platform-verified principal must equal configured runtime owner; no caller-supplied owner |
| `/api/chat-usage/policy` | PUT | Same owner; 4 KiB body limit, strict enabled/sampling/disclosure fields |
| `/api/chat-usage/summary` | GET | Same owner; UTC range ≤31 days, 1–4 allowlisted grouping dimensions, ≤200 groups |
| `/api/chat-usage/data` | DELETE | Same owner; 4 KiB body limit, empty payload; disables and erases analytics |

All responses are noncached. Missing authentication, foreign/implicit principals and missing runtime availability remain explicit errors; they are not an empty usage report. Web requests preserve the exact computer/runtime URL and Clerk account/session. Electron requests use the existing runtime-scoped authenticated API. Both ignore/abort responses after an identity change.

## Storage, limits and shutdown

Only owner-policy/scoped epochs and metadata-only generation facts/tags persist in owner PostgreSQL. Positive `ordinary` history is required; Google-derived, mixed, unknown, shared and imported contexts are excluded. Provenance is checked before classifier send and under the context transaction lock before tag commit. No context lock spans network inference. An already-admitted immutable ordinary snapshot does not gain later Gmail content; no zero-network-after-concurrent-taint guarantee is claimed.

Reports exclude expired records after the 30-day reporting window. Physical expiry cleanup runs in batches of at most 1,000 every five minutes while the configured analytics runtime runs. Shutdown stops its timer, drains the real expiry transaction and classifier work, and reports incomplete drain rather than permitting a false quiescence claim before owner database teardown. Owner-provided database pools are never closed by analytics.

The classifier uses the fixed Cloudflare-hosted Workers AI `@cf/openai/gpt-oss-20b` model through the existing Matrix relay with a background credential. Payload collection and caching are suppressed, `store:false` is set, redirects are rejected, and the request abort deadline is five seconds. The transport permits at most 100 attempts per hour per runtime. Existing relay funding/settlement and gateway-level controls continue to apply. This does not enable Cloudflare's stored-content Log Classification.

Runtime defaults cap outstanding receipts at 64, queued work at 32, active models at two, and retained snapshots at 256 KiB total. Admission queries, active model operations and retention work remain tracked through actual settlement even if cancellation is ignored. Failures drop classification without failing the successful primary response. Reports distinguish sampled/classified/recorded generations, unknown measurements and potentially truncated groups; they do not extrapolate omitted calls or infer task success.

## Verification and remaining gates

All heavy checks run on remote CI. Test-first cases cover provenance, epochs, private receipts, sampling, measured facts, capacity, cancellation, shutdown, storage, owner API authority, explicit consent, unknowns, account switching and failed reads. Native PostgreSQL separately exercises the real transaction path; its disposable fixture must be verified absent afterward.

Before activation qualify the exact committed build with full CI/review, pilot installation, actual ordinary opt-in/tagging and Gmail/mixed/unknown exclusion, stop/delete/expiry behavior, and captures for every affected supported surface. Browser captures do not qualify Electron, and Native Mobile remains explicitly deferred. No production/main rollout, processor approval, Google submission, CASA completion or audit-ready claim follows from source tests alone.
