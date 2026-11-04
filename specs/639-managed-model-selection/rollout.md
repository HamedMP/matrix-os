# Postpaid Gateway rollout and verification

This is a review checklist for a separately authorized deployment and the authorized release of existing customer holds. Publishing this PR does not change live accounts. Merging Platform changes to `main` can trigger the production Platform workflow, so merge/promotion is an accounting transition as well as a code release. Use an isolated candidate and disposable PostgreSQL before rollout; no customer Chat replay is required for these checks.

## Compatibility and order

1. Prepare the compatible Platform candidate and schema generation 24. It accepts immutable positive legacy captures, negotiated AI postpaid captures and internally captured Speech postpaid requests. Upgrade and verify the dedicated worker before promoting the Platform route; the production workflow deploys/verifies the worker before default-traffic promotion. Its cleanup must release expired AI and Speech customer holds with audits, never conservatively charge a later batch. Speech monthly usage limits remain separate from wallet credit.
2. Verify actual Platform and worker source, schema revision, active routes and health. Drain older Speech handlers/workers before introducing new captures. Strict postpaid Speech state/receipt checks must also reject old writers rather than allowing a zero reservation to become invented actual zero. Read bounded inventory before/after a cleanup cycle, including suspended/non-primary legacy Speech records; preserve private evidence outside the public repository.
3. Deploy the new Relay. New ordinary managed AI and Jev requests explicitly request `billingMode: "usage"` and `billingPolicy: "postpaid"`. A compatible Platform returns zero reserved credit and the exact requested provider liability ceiling. The Relay rejects mismatches and unsupported Platform responses before inference.
4. Verify one isolated request chain through authorization, start and exact settlement with a deterministic local provider. New authorization must not change credit, monthly reserves or promotional allocations. Successful actual usage is charged once against eligible funds and the completion month's budget. Failure/unknown usage must retain its Matrix-expense disposition and not debit a subsequent top-up.
   For an unconfirmed execution, verify that releasing credit does not admit another owner run before the original execution lease expires. At expiry, concurrent replicas may admit only one successor. A bound terminal receipt can release execution sooner.
5. Verify Speech through a deterministic local adapter and real operation/funding transaction. Wallet/source reservations remain zero; only its separately captured allowance lease may be occupied. Successful service cost follows validated audio duration and captured pricing. Timeout/cancellation/invalid response keeps unknown expense null and releases the matching allowance lease. Lost completion acknowledgement must replay the durable result without another debit or a contradictory waiver. Preview request limits remain enforced.

An old Relay never requests the postpaid marker, so the upgraded Platform does not silently return zero to a legacy AI caller. Deploying the new Relay first produces a safe refusal against the old Platform and is not the intended rollout order. Speech policy is captured internally by Platform; no public Gateway/client billing-policy field is introduced.

## Read-only inventory

In the reviewed operator environment with its existing `PLATFORM_DATABASE_URL` configuration:

```sh
bun scripts/inventory-expired-customer-credit.ts 100
```

The tool requires verified TLS for remote databases, requires the postpaid-aware schema, does not run migrations and has no apply mode. Results include a bounded page, `hasMore` and a continuation cursor. Pass the returned cursor as the second argument to inspect the next page. It identifies captured holds and maximum unknown provider liability; releasing a hold does not establish zero provider expense or guarantee that expired promotional funding becomes spendable.

The compatible deployed cleanup worker and postpaid admission perform the audited policy transition. Include every supported expired AI/Speech variant and preserve original-period allowance disposition. A legacy individually reviewed waiver may refuse these records because of its narrower machine/deletion/other-request guards; do not bypass that refusal with raw balance resets. Do not invent actual usage, delete history, reactivate a suspended machine or mint replacement credit.

## Completion and rollback boundaries

- Successful exact settlement is the accounting commit point. A lost settlement acknowledgement can follow a committed debit. Retry the identical request; do not submit a contradictory waiver or a second debit. The probe path completes all abortable access, pricing and lifetime checks before submitting its first charge.
- Strong terminal evidence permits immediate execution release. Unconfirmed cancellation leaves a bounded execution lease until expiry/cleanup, while customer credit remains unreserved. Neither path claims that the provider was cancelled or used zero resources.
- Preserve schema 24 and the release audit on rollback. Keep the postpaid-aware Platform responsible for settlement, cleanup and account-deletion accounting while any postpaid or policy-released provider expense is unknown. An older Platform can otherwise misinterpret these records. Relay rollback alone does not migrate or erase captures.
- A model listed as available, a passing fixture or a completed deployment is not live end-to-end billing acceptance. Record runtime versions and same-request accounting evidence separately before claiming production success.
