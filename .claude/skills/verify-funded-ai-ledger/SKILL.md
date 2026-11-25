---
name: verify-funded-ai-ledger
description: Check a change to the funded AI credit ledger (packages/platform/src/ai-funded-*.ts — holds, start, settle, release, expiry cleanup, promotional grants, the monthly budget window) against a TLA+ model that tries every order of those steps. Use before merging any change to those files or to the ai_funded_* tables, when a funded AI hold is stuck or a balance looks wrong, or when asked to verify the ledger.
---

# Verify the funded AI ledger

The funded AI ledger decides what a customer pays for Matrix AI. Its tests check the orders of steps someone thought of. This check tries every order of the ledger's steps, for a small number of requests and runtimes, and every way a clock that was read too early can arrive late.

Sync commit: `5330dda1a707e951a18d21019f1229c943437579` (the model describes the covered code as of this commit, the merge of the ENG-576 fix)

## Run it

```bash
.claude/skills/verify-funded-ai-ledger/check.sh            # the rules, about 1 minute
.claude/skills/verify-funded-ai-ledger/check.sh --mutants  # plus: prove each rule can still fail, about 3 more minutes
.claude/skills/verify-funded-ai-ledger/check.sh --drift    # only: which covered files changed since the sync commit
```

It needs Java 11 or newer and `python3`. The first run downloads TLC 1.7.4 and checks it against a pinned SHA-256.

Each line of output is one of:

- `PASS <config>`: no order of steps breaks any rule in that config.
- `FAIL <config>`: a rule broke. Exit code 1. The full TLC output path is printed.
- `ok` / `FAIL` under `--mutants`: see "Prove a rule can fail".

Read every TLC result, a pass or a break, with the pstack `/statechart` skill. For a break it gives the shortest path to the broken rule in plain words. For a pass it draws how the ledger moves between states. Give it `model/FundedLedger.tla` and the config that you want to read. Its chart has a state budget, so for a pass use a copy of a config with one runtime and one request. After the first broken rule it stops early and lists "Rules not checked"; `check.sh` stays the authority on which rules pass. If it asks where TLC is, `check.sh` keeps the pinned jar at `~/.cache/matrix-os-tla/tla2tools-1.7.4.jar`.

## The rules

Each rule is an invariant in `model/FundedLedger.tla` with the same name.

| Rule | The promise | The harm when it breaks |
| --- | --- | --- |
| `CreditMatchesLedger` | Every microdollar of a runtime's credit is explained by a ledger entry, and the promotional balance equals what is left of the grant. | Credit appears or disappears with no audit trail. |
| `ReservedMatchesHolds` | The reserved total of a runtime is exactly the holds of its open requests. | A customer's balance stays locked by a request that is gone, or a hold is spendable twice. |
| `HoldsAreBacked` | Open holds never exceed the credit, the add-on credit, and the promotional grant that back them. | Settlement throws "invariant violated" and the request cannot be charged or closed. |
| `ChargeIsCapped` | A request is charged once, never above its hold, and never after its customer charge was released. | A customer is overcharged or charged twice. |
| `StartedRequestsAreNotReleased` | A request that was sent to the provider is never closed as unused. | Matrix pays the provider and nobody is charged. |
| `OneUsageRequestPerOwner` | A usage-mode request is the owner's only open request. | Two requests spend the same hold; Matrix absorbs more than one request's overrun. |
| `MonthReservedMatchesHolds` | This month's reserved counter is exactly the open holds counted in this month's window. | Settlement of a hold fails on `CHECK (month_reserved_microusd >= 0)`. |
| `BudgetIsHonored` | What a runtime is charged for a month, plus what it still holds for that month, never exceeds its monthly budget. | A runtime spends past its budget. |
| `HoldsCanBeReleased` | Every open hold can be given back once its deadline passes. | A request can be neither settled nor expired; it keeps its hold, and a usage-mode one blocks all of the owner's funded AI. |
| `MonthNeverMovesBack` | A runtime's budget window never returns to an earlier month. | The month's spend and holds are forgotten; see History. |

## The configs

| Config | Size | Rules | Expected |
| --- | --- | --- | --- |
| `OneRuntime` | 1 runtime, 3 requests | all ten | PASS |
| `TwoRuntimes` | 2 runtimes, 2 requests | all ten | PASS |

Both configs: clocks may arrive late, amounts up to 2, one promotional grant of 2 that can expire, one add-on grant of 2, a monthly budget of 3, and one month change.

## Does your change touch the verified code?

It does when it edits a function in this table, a query on an `ai_funded_*` table that these functions read or write, a lock they take, or the order of their statements.

| Code (under `packages/platform/src/`) | Model action or operator |
| --- | --- |
| `ai-funded-authorization.ts` `createFundedAuthorize` | `Authorize` |
| `ai-funded-priority-claims.ts` `findConflictingActiveReservation`; `ai-funded-reservation-indexes.ts` index `idx_ai_funded_usage_active_owner` | `Conflict` |
| `ai-funded-metering-repository.ts` `startReservation` | `Start` |
| `ai-funded-metering-repository.ts` `releaseReservation` | `ReleaseBegin`, `ReleaseCommit`, `ReleaseAbort` |
| `ai-funded-metering-repository.ts` `settleReservationInternal`, prepaid path; `ai-funded-metering-helpers.ts` `recordUsageFunding`; `ai-funded-reservation-sources.ts` `reservationDebitSplit`, `debitAttributedPromotionalGrants` | `SettlePrepaid` |
| `ai-funded-postpaid-settlement.ts` `settlePostpaidUsage`; `ai-funded-reservation-sources.ts` `debitPromotionalGrants` | `SettlePostpaid` |
| `ai-funded-metering-repository.ts` `settleReservationInternal`, mode `conservative` | `ConservativeFinalize` |
| `ai-funded-customer-charge-release.ts` `releaseCustomerCharge` | `ReleaseCharge` |
| `ai-funded-customer-credit-cleanup.ts` `cleanupOwnerCustomerCharges`, `cleanupExpiredCustomerCharges` | `Cleanup` |
| `ai-funded-metering-repository.ts` `grantCreditInTransaction` | `GrantPromo` (a `promotion:` entry, with handoff between runtimes), `GrantAddon` |
| `ai-funded-metering-repository.ts` `getRuntimeFundingSummary` | `Summary` |
| `ai-funded-reservation-sources.ts` `reconcileExpiredPromotionalCredit` | `Reconcile` |
| `ai-funded-reservation-sources.ts` `readFundingSources`, `allocateFundingSources`, `activePromotionalProtection`, `activeAddonProtection` | `Sources`, `PromoProt`, `AddonProt` |
| `ai-funded-metering-helpers.ts` `advanceMonthWindow`, used by authorize, release, settle, summary, and by `speech/funding.ts` and `speech/funding-postpaid.ts` | `ResetMonth` |
| `database/migrations/ai-funded.ts` `CHECK (… >= 0)` on `ai_funded_runtime_balances` | every `Fail(...)` branch |

What the model treats as one step:

- Authorize, start, settle, finalize, cleanup, promotional grant, and summary each hold `pg_advisory_xact_lock('funded-ai-owner:<owner>')` for their whole transaction. Each is one step.
- `releaseReservation` does not take that lock. It locks the reservation row, then the balance row. It is two steps, and every action that needs the same reservation row waits while `lock[r].held`.
- `options.now()`: authorize, start, release, summary, and grant read it before their transaction. They may act on an older month or an older "has it expired" answer than a transaction that already committed, and every config checks the rules that way (`StaleClock = TRUE`). Settle and `releaseCustomerCharge` read it after their locks.

If your change breaks one of these three statements, for example it removes the owner lock from a transaction, the model's steps are wrong for the new code. Split that action into the steps between its lock acquisitions before you trust a PASS.

## When the covered code changed

1. Run `check.sh --drift`. For each changed function, read the diff next to its model action.
2. If the change is not visible to the model (logging, error text, a refactor that keeps statements, locks, and their order), change nothing in the model.
3. Otherwise edit the action so that it does what the code now does: the same guards, the same arithmetic, in the same order. Use the code's names. Do not edit a rule to make it pass.
4. Run `check.sh --mutants`. A mutant that "is not in the model exactly once" edits text that you changed: update its find and replace text in `mutants.py` so that it mirrors the same code mistake again.
5. If you add a rule, add a mutant that breaks it, and add the rule to a config.
6. Only when steps 1 to 5 are done and the check is back to its expected results, set `Sync commit` above to the commit you checked.

## A rule broke: real bug or modeling error?

1. Read the path with `/statechart`. Write it as steps in the code's words, one for each action, using the table above.
2. Open the code for each step. Confirm that the code can take that step from that state: the guard holds, the lock is free, the values are what the model says. The first step the code cannot take is a modeling error. Fix the model, and say what you fixed.
3. If the code can take every step, replay the path on the real code as a test: one call for each action, with the repository's injected `now` for clock steps. `tests/platform/ai-funded-month-window.test.ts` is the pattern. If the replay does not show the break, treat the model as wrong until you find the step that differs.
4. A path that replays is a finding. Report it with the path in the code's words and the harm. Do not weaken the rule, and do not change product code unless you were asked to.

## Prove a rule can fail

`check.sh --mutants` makes eight small edits to a copy of the model. Each mirrors one mistake in the code, such as "releaseCustomerCharge does not give the hold back", and TLC must report the named rule as broken. TLC stops at the first broken rule, so a month mutant passes when any of the four month rules breaks.

A check that still passes after you removed a guard from the real code has a gap. Mirror that removal in the model: if the rules still pass, the model is missing that guard or a rule that needs it.

## History

- ENG-576: this check found that a transaction with a clock from before midnight could move a runtime's budget window back to the old month, after which an open request could be neither settled nor expired. The fix is `advanceMonthWindow`, which only moves the window forward, and each hold now stores the window it was counted in. The regression tests are `tests/platform/ai-funded-month-window.test.ts`; the mutants `window-moves-back` and `hold-keeps-callers-month` put the bug back and must be caught.

## What a PASS does not cover

- Sizes beyond the configs: more than 3 requests, 2 runtimes, one promotional grant, or amounts above 2. The model has one owner; owners share no ledger rows.
- Left out of the model: speech reservations and allowances (only their use of `advanceMonthWindow` is covered), usage waivers, execution recovery (`execution_admission_release`, `terminal_outcome`), legacy reservations without source attribution and the funding shortfall they create, refunds and disputes (`ai_funded_credit_restrictions`), preview runtime quotas, priority claims (they only refuse more requests), credential and policy checks, the Jev pricing and manual review checks, and idempotent replays of a finished call.
- The model is a hand translation of the code. A PASS says the design in the model keeps the rules. It says the code keeps them only as far as the table above is true. That is what the sync commit, the drift list, and the replay step are for.
- Postgres itself: `READ COMMITTED` visibility inside one statement, deadlocks, and lock timeouts are not modeled. Lock order was read from the code once, at the sync commit, and no cycle was found.
