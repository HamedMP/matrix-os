# Funded AI pricing operations

Platform checks the official rates and retirement notices once a day. An exact
match renews a review for up to 30 days when seven or fewer days remain. Published
retirements can shorten this window. An inconclusive source leaves the previous
approval usable through its existing deadline. A verified rate change blocks new
requests for that model. Requests already sent to a provider settle using the
price version they started with. Jev retains its independent review.

Review exceptions and missed runs create or update Engineering issues in Linear.
The Engineering Slack integration delivers those events to `#alert-linear-eng`.
The worker escalates the same issue at three days and one day before the
deadline. The watchdog checks independently for a successful review within 26
hours. Before the first recorded success, the first persisted watchdog check starts a
one-hour bootstrap window that survives process restarts.

## Internal endpoint access

| Route | Caller | Authentication |
| --- | --- | --- |
| `GET /internal/ai/funded/pricing-reviews` | Relay | Existing Relay control bearer |
| `POST /internal/ai/funded/pricing-route-failure` | Relay | Existing Relay control bearer |

Only the exact trusted Relay control token authorizes these routes. The report
carries a known model ID, its immutable rate version and a recent timestamp.
Reports can invalidate an older healthy probe for that rate version. They do
not spend probe allowance. The snapshot carries review metadata without customer
data. Both operations are unavailable when the Funded AI control plane is off.

## Activate

1. Keep existing Relay price reviews current during rollout. Enable
   `MATRIX_FUNDED_AI_PRICING_REVIEW_JOB_ENABLED` on Platform first. Set
   `MATRIX_FUNDED_AI_PRICING_LINEAR_TEAM_ID`,
   `MATRIX_FUNDED_AI_PRICING_LINEAR_OPEN_STATE_ID`,
   `MATRIX_FUNDED_AI_PRICING_LINEAR_COMPLETED_STATE_ID` and the numeric
   `MATRIX_FUNDED_AI_PRICING_LINEAR_TOKEN_VERSION` in the corresponding GitHub
   environment. Mount the dedicated `funded-ai-pricing-linear-token` through
   Secret Manager. The configured team must be Engineering (`ENG`).
2. Verify the private Platform worker records a successful review and the
   serving Platform revision runs the watchdog. Check a controlled exception
   on the isolated acceptance chain and confirm one Linear issue, Slack
   delivery, escalation and closure. Confirm the published price record and
   audit digest for each currently enabled text model. When documentation
   omits a chargeable rate, obtain authoritative evidence and keep that
   route on its current reviewed configuration until its registry coverage
   or a verified replacement is ready. Never extend an approval from an
   incomplete document.
3. After confirming catalog coverage, enable the GitHub environment variable
   `MATRIX_FUNDED_AI_PRICING_REGISTRY_ENABLED` for Platform and
   `MATRIX_FUNDED_AI_RELAY_PRICING_REGISTRY_ENABLED` for the isolated Relay
   candidate. Demonstrate
   concurrent replicas skip synthetic inference for expired models, share
   eligible probe results, and keep a healthy model available for paid Chat
   and correct settlement when retry capacity is exhausted. Verify a daily
   review update becomes effective without a Relay restart. Capture this in
   the `pricing_registry` check along with the worker and notification
   evidence. Record the exact Platform and Relay revisions.
4. Promote using the [Relay release evidence workflow](./production-release-evidence.md).
   Check every enabled route and default, including customer Hosts that use a
   tagged Relay URL. Leave current spend and probe fuse settings in place
   through acceptance. Review real probe volume before reducing the daily
   limit.

For a published retirement, check replacement compatibility, published rates,
streaming Chat and settlement before changing the catalog or default. If rollback
is required, restore a verified Platform/Relay configuration with current price
reviews. Keep the registry and audit data. A rollback cannot renew an expired
review or restore an upstream model that the provider has withdrawn.
