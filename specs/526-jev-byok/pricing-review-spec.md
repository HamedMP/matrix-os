# Jev operator pricing review

## Problem and behavior

The immutable Jev input price was valid only through September 30, 2026. An unchanged price still became unavailable on October 1, blocking the Inbox workflow before upstream dispatch. Operators must be able to attest a new, bounded review of the same rate without rebuilding application source.

The reviewed rate remains `typesafe-jev-input-2026-09`: 42 nanoUSD per input token ($0.042 per million), zero output cost. Provider reference: https://developers.cloudflare.com/ai/models/typesafe/jev/. A changed rate requires a new reviewed code/pricing version; environment configuration cannot alter rate, billing provenance, or settlement arithmetic.

## Configuration authority

Only trusted Relay deployment configuration supplies this attestation; requests, prompts, recipes, and owner credentials cannot supply it.

| Environment setting | Required value |
| --- | --- |
| `MATRIX_JEV_PRICING_REVIEW_VERSION` | Exact immutable pricing version `typesafe-jev-input-2026-09` |
| `MATRIX_JEV_PRICING_REVIEWED_AT` | Explicit operator review timestamp, canonical UTC ISO with milliseconds |
| `MATRIX_JEV_PRICING_VALID_THROUGH` | Explicit inclusive expiry, canonical UTC ISO with milliseconds |

Provide all three settings together. The validity window must be positive and no longer than 90 days. Canonical timestamps round-trip exactly and cannot contain normalized invalid calendar dates, offsets, or whitespace. Partial, malformed, incompatible, or excessively long reviews reject configuration. Reviews dated in the future, expired reviews, and invalid request clocks fail closed before reservation or provider dispatch.

When all settings are absent, preserve the historical September snapshot for compatibility, including its expiry. Never extend it using process-start time or automatically set a new date. Operators must independently verify the official provider rate before renewal and schedule another review before the configured expiry. No permanent-valid pricing escape hatch exists.

## Runtime and accounting

The Relay resolves the configured review before Jev policy admission and snapshots its immutable rate/version and actual validity interval. The authenticated owner-funded readiness endpoint returns that snapshot's actual `priceValidThrough`, after paid-probe settlement and authorization revalidation. Probe readiness is denied if the review expires while the probe runs.

An already-started evaluation retains its admitted pricing snapshot for exact usage settlement even if the review expires in flight. Existing unknown-usage/manual-reconciliation and reservation-release behavior remain. Renewal does not change pricing provenance or authorize replay of uncertain Gmail operations.

No new endpoint or authentication mechanism is introduced. All existing owner, model, reservation, and account-binding checks remain. Sonnet/GLM price reviews and public checkout policy are outside this change.

## Validation and delivery

- October 1 with explicit reviewed configuration: paid synthetic probe completes, cost settles at 12 microUSD for 275 input tokens, immutable provenance remains, actual configured expiry is returned.
- Missing, future, and expired review: no authorization/reservation/upstream dispatch.
- Partial, malformed, mismatched-version, invalid-calendar, and greater-than-90-day reviews: fail closed.
- In-flight expiry: no false probe readiness; real evaluation settles its admitted price accurately.
- Retain existing request validation, accounting, timeout, body-limit, and settlement tests with deterministic clocks.
- Deploy the exact reviewed Relay build plus explicit operator attestation; run Main Computer/Electron Desktop and independently verify Gmail labels before claiming end-to-end acceptance.
- Companion public documentation: `FinnaAI/matrix-os-site` PR #146 describes Jev readiness and explicit operator review renewal; its 233 site tests pass.
- Preserve canonical preflight error codes/messages and retryability across Hermes execution, so readiness/setup failures are not mislabeled as a Hermes connection failure.
