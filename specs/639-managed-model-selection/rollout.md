# Postpaid Gateway rollout and verification

This is a review checklist for a separately authorized deployment. Building or merging this PR does not change live accounts. Use an isolated candidate and disposable PostgreSQL before production rollout; no customer Chat replay is required for these checks.

## Compatibility and order

1. Deploy the new Platform and schema generation 24 together. It accepts both immutable positive legacy captures and explicitly negotiated postpaid usage captures. Its cleanup worker changes expired AI requests to audited customer-charge releases; it must never conservatively charge a later batch of expired AI requests. Speech keeps its separate allowance rules.
2. Verify the actual running Platform source, schema revision, worker configuration and health. Read the bounded inventory before and after a cleanup cycle, preserving private accounting evidence outside the public repository.
3. Deploy the new Relay. New ordinary managed AI and Jev requests explicitly request `billingMode: "usage"` and `billingPolicy: "postpaid"`. A compatible Platform returns zero reserved credit and the exact requested provider liability ceiling. The Relay rejects mismatches and unsupported Platform responses before inference.
4. Verify one isolated request chain through authorization, start and exact settlement with a deterministic local provider. New authorization must not change credit, monthly reserves or promotional allocations. Successful actual usage is charged once against eligible funds and the completion month's budget. Failure/unknown usage must retain its Matrix-expense disposition and not debit a subsequent top-up.

An old Relay never requests the postpaid marker, so the upgraded Platform does not silently return zero to a legacy caller. Deploying the new Relay first produces a safe refusal against the old Platform and is not the intended rollout order.

## Read-only inventory

In the reviewed operator environment with its existing `PLATFORM_DATABASE_URL` configuration:

```sh
bun scripts/inventory-expired-customer-credit.ts 100
```

The tool requires verified TLS for remote databases, requires the postpaid-aware schema, does not run migrations and has no apply mode. Results include a bounded page, `hasMore` and a continuation cursor. Pass the returned cursor as the second argument to inspect the next page. It identifies captured holds and maximum unknown provider liability; releasing a hold does not establish zero provider expense or guarantee that expired promotional funding becomes spendable.

The deployed cleanup worker and negotiated postpaid admission perform the audited policy transition. Do not replace that transition with direct balance updates, invented actual usage, deleted history or a bulk status patch.

## Completion and rollback boundaries

- Successful exact settlement is the accounting commit point. A lost settlement acknowledgement can follow a committed debit. Retry the identical request; do not submit a contradictory waiver or a second debit. The probe path completes all abortable access, pricing and lifetime checks before submitting its first charge.
- Strong terminal evidence permits immediate execution release. Unconfirmed cancellation leaves a bounded execution lease until expiry/cleanup, while customer credit remains unreserved. Neither path claims that the provider was cancelled or used zero resources.
- Preserve schema 24 and the release audit on rollback. Keep the postpaid-aware Platform responsible for settlement, cleanup and account-deletion accounting while any postpaid or policy-released provider expense is unknown. An older Platform can otherwise misinterpret these records. Relay rollback alone does not migrate or erase captures.
- A model listed as available, a passing fixture or a completed deployment is not live end-to-end billing acceptance. Record runtime versions and same-request accounting evidence separately before claiming production success.
