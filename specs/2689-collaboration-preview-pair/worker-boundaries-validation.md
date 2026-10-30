# Ordinary worker isolation checkpoint

[ENG-418](https://linear.app/matrix-os/issue/ENG-418) remains In Progress.
This layer keeps ordinary customer worker authority outside pair-owned machines,
provisioning jobs, metadata and deletion intents. The configured controller,
protected automation, Electron and live acceptance remain open in tasks.md.

## Named faults and actual boundaries

The regressions run actual customer reconciliation and dispatch against fresh
Postgres, with actual pair admission and both durable provisioning jobs. Provider
HTTP and the customer object store are explicit fixtures. A batch limit of one
exposes starvation as well as unwanted mutation. Ordinary `cp-customer` remains
eligible: the guard uses the exact reserved handle grammar and canonical member
ledger, not a broad prefix. A reserved orphan and a renamed canonical member are
both excluded. Ordinary running-machine metadata reaches only the customer store.

Before the guards, ordinary reconciliation failed a stale pair machine, older
pair jobs starved customer dispatch, and pair metadata entered the customer
store. Reintroducing the unfiltered predicates reproduced five assertion failures
with the unchanged direct-dispatch exclusion still passing. Invalid initial test
setup (preparing outside a transaction and incomplete running-machine metadata)
was corrected and is not counted as regression evidence.

Actual deletion queue ownership exposed two further failures: ordinary customer
reconciliation issued DELETE for pair server801 before customer server999, and
composed pair retirement remained cleanup-pending when an earlier compensation
already occupied the unique active deletion intent. Ordinary selection now
excludes canonical members and reserved markers before LIMIT. Pair draining
accepts an existing compensation only after its exact member/machine/handle,
current claim, source retirement and live provider labels are verified. A reason
string never grants deletion authority. The post-network claim fence remains.

## Invariants and limits

SQL predicates only deny ordinary authority; they do not grant pair access.
Normal orphan-job and orphan-deletion handling remains available. Pair deletion
still uses the established durable queue/backoff and retains its lease until
independent physical absence is established. Provider calls stay outside ledger
transactions. No customer VPS, cloud resource, sharing grant or membership was
changed, and no normal-login collaboration success or visual evidence is claimed.

The existing customer service and dispatcher remain focused legacy modules at
836 and723 lines respectively. This layer adds selector options and puts shared
predicates in a new focused module rather than growing orchestration behavior.

## Qualification

Six-file qualification passed41/41 assertions with zero skips/unhandled errors
and process exit0: preview-pair-dispatch-postgres (7), preview-pair-wiring-postgres
(4), preview-pair-provider-drain-postgres (1), customer-vps-provisioning-durability,
customer-vps-reconciliation-worker and customer-vps-registration-delete (29
retained assertions). The earlier four-file worker qualification passed35/35.

The corrected compensation regression first reproduced cleanup remaining pending
with the provider ID read from the actual owner machine. Its earlier fixture
assumed server801 belonged to the owner; the live-label guard correctly rejected
that inconsistent association. That attempt is not counted as valid red/green
evidence. The corrected test passes in the complete six-file run.

The required CI Postgres jobs for #3039 and #3040 were cancelled at their
10-minute job limit after completed batches passed. Their aggregate CI is not
green; both PRs were returned to draft. The expanded suite needs a measured
qualification budget with margin before readiness can be claimed.

All eight native TypeScript projects passed (exit0). Strict SQL inventory
validated76 files. Committed-source pattern results follow the commit check.
