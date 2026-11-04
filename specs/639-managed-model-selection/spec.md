# AI Gateway availability and customer credit recovery

Tracking: [ENG-182](https://linear.app/matrix-os/issue/ENG-182/ship-and-qualify-matrix-ai-gateway-with-dollar5-starter-credit), with the existing availability/failure history in [ENG-205](https://linear.app/matrix-os/issue/ENG-205/matrix-ai-is-unavailable). The owner's 2026-11-04 credit-policy decision below supersedes the historical hold-preservation policy; linking an existing ticket is not an acceptance or deployment claim.

## User outcome

Owners can see and explicitly choose every policy-discovered Matrix AI Chat model even when service health cannot currently be verified. The selected model remains visible as unavailable and survives picker reopen, catalog refresh, and draft restoration. Choosing a model does not authorize execution.

## Contract

- Apply to Electron Desktop, Web Desktop, Web Canvas, Web Mobile, and Native Mobile wherever the ordinary Chat model picker exists.
- A catalog row is eligible for the outage exception only for the canonical managed Pi instance, an advertised model, root Chat support, unavailable execution state, unavailable connection state, and the runtime-unavailable reason. Do not invent rows absent from the authenticated catalog.
- Keep credit-required, credit-reserved, monthly-budget, policy, authentication, retired, disabled, and unsupported routes fail-closed. Contradictory ready/funding-blocked records do not gain selection permission.
- Keep selection intent separate from execution readiness. Retain the selected model and its unavailable label; do not silently replace it with a healthy peer.
- Preserve strict server turn/queue admission, account and option binding, descriptor default-selection validation, and available-only automatic defaults. No new wire fields or persistence schemas are required.
- Automatic onboarding task routing remains runnable-only; its existing connected-provider fallback does not inherit ordinary Chat's explicit model-choice exception.
- Keep Bot configuration eligibility unchanged. Chat-only presentation opts into unavailable managed choices; shared defaults used by Bot configuration stay runnable-only.
- Sending remains disabled until the selected model is executable. Readiness recovery enables that exact selected model without changing draft content or options.

## Implementation and verification

1. Add a shared contracts predicate for catalog-backed model selection intent; reuse it in shared Chat choices, picker rows, explicit composer selection and saved preferences, and Native Mobile picker derivation.
2. Add failing behavioral tests at the real shared picker, Web Chat provider state, Electron composer state, and Native Mobile picker seams. Cover outage selection, refresh/restoration, peer-ready no-fallback, recovery, and funding/auth/Bot negative cases before implementation.
3. Run focused shared and mobile regressions, relevant typechecks and production Desktop build. Inspect the actual built Electron picker with an isolated deterministic catalog fixture, without touching owner conversations or calling a model.
4. Publish the implementation PR and a separate `FinnaAI/matrix-os-site` documentation PR updating `content/docs/matrix-ai-models.mdx`. Do not merge or deploy this UI change without the user's authorization.

## Operational boundary

Probe-budget and pricing-review remediation are separately authorized operations. No merge, deployment, account adjustment, or new production inference is implied by this implementation.

## Customer credit policy (2026-11-04 scope extension)

The owner explicitly requests cancelling credit reservations after failed hackathon requests froze all spendable credit. This supersedes the earlier requirement to retain customer monetary holds for unknown AI usage. Preserve financial truth and provider expense; Matrix assumes failed or unconfirmed request expense.

Maintainer scope decision (2026-11-04): keep the availability and customer-credit fixes together in this existing PR as one AI Gateway incident follow-up. This explicitly overrides the normal 50-file PR split rule for this change. Preserve the necessary cross-surface, compatibility and financial regression coverage; no general repository size-policy change is implied.

- New managed AI Gateway requests explicitly negotiate `billingPolicy: "postpaid"` with usage billing. Keep the existing request record, positive provider liability ceiling, authenticated owner/runtime identity, idempotency, start/dispatch fencing, and bounded execution admission. Reserve zero customer credit and zero monthly budget; do not allocate promotional grants before execution.
- Old authorization captures retain their original meaning. New contracts accept zero monetary reservation only with the captured postpaid usage policy. Deploy the compatible Platform/schema first, then the Relay that explicitly requests postpaid. Existing Relay binaries continue receiving positive legacy holds because they do not request the new policy; the Platform must not silently return zero for a legacy request. New Relay binaries fail closed against a Platform that does not support the policy. Production rollout is separately authorized.
- Successful confirmed usage charges actual cost once, capped by currently eligible promotional/add-on credit and the completion month's remaining budget under the existing owner transaction lock. Matrix absorbs the remainder without negative credit, shortfall debt, or later top-up clawback.
- Gateway failures/cancellation and unconfirmed usage never debit the customer. Persist a permanent no-customer-charge disposition; unknown actual remains null. Authenticated exact late receipts may record provider expense once, entirely borne by Matrix, without releasing a newer request or debiting a later top-up.
- Terminal evidence must not retroactively waive an already successful exact settlement. Validate immutable request/start bindings and conflicting replays. Confirmed terminal evidence closes execution admission immediately. If upstream termination cannot be confirmed, the customer still has no financial hold; the bounded execution lease expires through cleanup without claiming upstream cancellation or zero expense.
- Release stale legacy AI holds once through an audited policy transition, retaining original authorization/source split, original hold, release amount, policy version, reason, timestamps, and unknown provider liability. Every cleanup entry point must adopt this rule for AI requests; an older conservative cleanup pass must not charge records beyond the first release batch. Do not change successful prior charges, mint credits, delete history, reset balances, or convert speech monthly allowances. Include bounded cleanup and an auditable dry-run inventory for existing holds; no production apply in this PR work.
- Unknown Matrix liability remains visible to accounting and account deletion/export; it must neither disappear with an expired status nor permanently block ordinary future Chat admission. Existing operator-waiver/recovery caps are not the recurring customer failure policy.
- Settings/Chat display remaining actual credit without a Reserved-credit block for these postpaid AI requests. Preserve speech allowance and legacy protocol compatibility where required.

### Verification seams

Use the real Platform authorize/start/finalize/terminal/cleanup APIs and funded Relay HTTP/stream interfaces. Cover zero hold, success actual charge, failure/unknown no debit, exact/conflicting replay, grant expiry/month rollover/top-ups, stale legacy hold recovery, timeout/late receipt, deletion accounting, and unrelated speech/legacy behavior. Disposable PostgreSQL with independent pools must verify owner locking, duplicate settlement, cleanup/late-settlement races and no negative balances. No paid model calls are required.

Update the existing implementation PR and the separate site documentation PR together. Extend the PR title/body to cover final Gateway availability and credit behavior.
