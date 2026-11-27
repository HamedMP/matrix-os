---------------------------- MODULE FundedLedger ----------------------------
(* A model of the funded AI credit ledger in packages/platform/src.

   One owner, a few runtimes (machines), one owner-wide promotional grant,
   add-on grants, and a few funded requests (reservations).

   What one step is. Authorize, start, settle, finalize, cleanup, promotional
   grant and funding summary all take the owner advisory lock
   (pg_advisory_xact_lock 'funded-ai-owner:<owner>') for the whole
   transaction, so each is one step here. releaseReservation does NOT take
   that lock: it locks the reservation row, then the balance row. It is two
   steps here (ReleaseBegin, ReleaseCommit), and every transaction that needs
   the same reservation row waits while lock[r] is held.

   The clock. authorize, startReservation, releaseReservation,
   getRuntimeFundingSummary and grantCredit read options.now() BEFORE they
   open their transaction and wait for locks. When StaleClock is TRUE such a
   transaction may act on an older month or an older "has it expired" answer
   than a transaction that committed before it. settleReservationInternal and
   releaseCustomerCharge read the clock after their locks, so they never do.
   The rules must hold with StaleClock = TRUE: that is how the code runs.

   Each action names the function it models. See ../SKILL.md for the map. *)
EXTENDS Integers, FiniteSets, TLC

CONSTANTS
  Machines,     \* runtimes of the one owner
  Rids,         \* funded requests
  MaxCost,      \* largest maxCostMicrousd a request may ask for
  PromoAmount,  \* amount of the owner-wide promotional grant
  AddonAmount,  \* amount of one add-on grant
  AddonGrants,  \* how many add-on grants may be made
  Budget,       \* monthly_budget_microusd of every runtime
  StaleClock    \* TRUE: clocks read before lock waits may be old (how the code runs)

VARIABLES
  month,        \* wall clock: UTC month, 0 then 1
  promoExpired, \* wall clock: the promotional grant's expires_at has passed
  bal,          \* ai_funded_runtime_balances, one row per machine
  grant,        \* ai_funded_promotional_grant_balances row of the one grant
  res,          \* ai_funded_usage_reservations, one row per request
  lock,         \* reservation row lock held by an open releaseReservation
  addonLeft,    \* add-on grants not yet made
  ledger        \* owner-wide sums of ai_funded_credit_ledger entries

vars == <<month, promoExpired, bal, grant, res, lock, addonLeft, ledger>>

Months == 0..1
Modes == {"hold", "usage", "postpaid"}
\* ACTIVE_RESERVATION_STATUSES. "starting", "settling" and "releasing" exist
\* only inside one transaction and are never visible to another.
Active == {"reserved", "in_flight"}

Min(a, b) == IF a <= b THEN a ELSE b
Max(a, b) == IF a >= b THEN a ELSE b

RECURSIVE SumOf(_, _)
SumOf(f, S) ==
  IF S = {} THEN 0
  ELSE LET x == CHOOSE y \in S : TRUE IN f[x] + SumOf(f, S \ {x})

NoRes == [status |-> "none", machine |-> "nil", mode |-> "hold", max |-> 0,
          hold |-> 0, promoAlloc |-> 0, addonRes |-> 0, period |-> 0,
          started |-> FALSE, late |-> FALSE, chargeReleased |-> FALSE,
          charged |-> 0, spendPeriod |-> 0, capOk |-> TRUE]

\* A closed request keeps only what the rules below still read. This keeps the
\* model small; it drops nothing a later step of the code would use.
Released(x) == [NoRes EXCEPT !.status = "released", !.started = x.started]
Settled(x, a, charged, p) ==
  [NoRes EXCEPT !.status = "settled", !.machine = x.machine, !.charged = charged,
                !.spendPeriod = p,
                !.capOk = /\ charged <= a /\ a <= x.max
                          /\ (x.mode # "postpaid" => charged <= x.hold)
                          /\ (x.chargeReleased => charged = 0)]
ChargeReleased(x) ==
  [NoRes EXCEPT !.status = "expired", !.chargeReleased = TRUE, !.machine = x.machine,
                !.mode = x.mode, !.max = x.max, !.started = x.started, !.late = x.late]

NoLock == [held |-> FALSE, month |-> 0, expired |-> FALSE]

IsActive(x) == x.status \in Active

\* activePromotionalProtection / activeAddonProtection
PromoProt(R, m) ==
  SumOf([r \in Rids |-> IF IsActive(R[r]) /\ R[r].machine = m THEN R[r].promoAlloc ELSE 0], Rids)
AddonProt(R, m) ==
  SumOf([r \in Rids |-> IF IsActive(R[r]) /\ R[r].machine = m THEN R[r].addonRes ELSE 0], Rids)

\* The rows one transaction writes. ok = FALSE means the code threw (an
\* "invariant violated" error or a CHECK constraint), so nothing commits.
Cur == [ok |-> TRUE, bal |-> bal, grant |-> grant, ledger |-> ledger]
Fail(S) == [S EXCEPT !.ok = FALSE]
Commit(S) == /\ S.ok
             /\ bal' = S.bal
             /\ grant' = S.grant
             /\ ledger' = S.ledger

\* reconcileExpiredPromotionalCredit: retire the expired, unprotected remainder.
Reconcile(S, R, m, seenExpired) ==
  LET g == S.grant
      retired == g.remaining - PromoProt(R, m)
  IN IF ~S.ok \/ ~(g.exists /\ g.machine = m /\ g.remaining > 0 /\ seenExpired) THEN S
     ELSE IF retired < 0 \/ S.bal[m].credit < retired \/ S.bal[m].promo < retired THEN Fail(S)
     ELSE [S EXCEPT !.grant.remaining = @ - retired,
                    !.bal[m].credit = @ - retired,
                    !.bal[m].promo = @ - retired,
                    !.ledger.expired = @ + retired]

\* advanceMonthWindow (ai-funded-metering-helpers.ts), the lazy month roll that
\* authorize, release, settle and summary all run. It only moves forward: a
\* caller with an older month leaves the window and its counters alone.
ResetMonth(S, m, p) ==
  IF ~S.ok THEN S
  ELSE [S EXCEPT !.bal[m].period = Max(@, p),
                 !.bal[m].spent = IF S.bal[m].period >= p THEN @ ELSE 0,
                 !.bal[m].mres = IF S.bal[m].period >= p THEN @ ELSE 0]

\* readFundingSources
Sources(S, R, m, seenExpired) ==
  LET g == S.grant
      here == g.exists /\ g.machine = m /\ g.remaining > 0
      gAvailRaw == g.remaining - PromoProt(R, m)
      eligible == here /\ ~seenExpired
      addonAvail == S.bal[m].addon - AddonProt(R, m)
      gTotal == IF eligible THEN g.remaining ELSE 0
      gAvail == IF eligible THEN gAvailRaw ELSE 0
  IN [throws |-> (here /\ gAvailRaw < 0) \/ addonAvail < 0,
      gAvail |-> gAvail,
      addonAvail |-> addonAvail,
      ceiling |-> gTotal + S.bal[m].addon,
      avail |-> gAvail + addonAvail]

\* findConflictingActiveReservation: usage-mode admission is owner-exclusive.
Conflict(R, mode) ==
  \E x \in Rids :
    /\ \/ IsActive(R[x])
       \/ R[x].status = "expired" /\ R[x].chargeReleased /\ R[x].started /\ ~R[x].late
    /\ mode # "hold" \/ R[x].mode # "hold"

ClockMonths == IF StaleClock THEN 0..month ELSE {month}
ClockExpired == IF StaleClock THEN {FALSE, promoExpired} ELSE {promoExpired}
SeesLate(r) == IF StaleClock THEN {FALSE, res[r].late} ELSE {res[r].late}

-----------------------------------------------------------------------------
\* createFundedAuthorize (ai-funded-authorization.ts)
Authorize(r, m, mode, max, cm, ce) ==
  /\ res[r].status = "none"
  /\ LET S1 == ResetMonth(Reconcile(Cur, res, m, ce), m, cm)
         b == S1.bal[m]
         src == Sources(S1, res, m, ce)
         availCredit == Min(src.avail, b.credit - b.reserved)
         availBudget == Budget - b.spent - b.mres
         ceilingHold == IF mode = "hold" THEN max ELSE 1
         hold == CASE mode = "postpaid" -> 0
                   [] mode = "usage" -> Min(max, Min(availCredit, availBudget))
                   [] OTHER -> max
         pa == Min(src.gAvail, hold)
         ad == hold - pa
     IN /\ S1.ok /\ ~src.throws
        /\ ceilingHold <= Budget - b.spent
        /\ ceilingHold <= Min(src.ceiling, b.credit)
        /\ mode # "hold" => (availCredit > 0 /\ availBudget > 0)
        /\ ~Conflict(res, mode)
        /\ hold <= src.avail
        /\ b.credit - b.reserved >= hold
        /\ availBudget >= hold
        /\ ad <= src.addonAvail
        /\ Commit([S1 EXCEPT !.bal[m].reserved = @ + hold, !.bal[m].mres = @ + hold])
        /\ res' = [res EXCEPT ![r] = [NoRes EXCEPT
               !.status = "reserved", !.machine = m, !.mode = mode, !.max = max,
               !.hold = hold, !.promoAlloc = pa, !.addonRes = ad,
               \* The hold belongs to the window it was counted in, not to this clock.
               !.period = b.period]]
  /\ UNCHANGED <<month, promoExpired, lock, addonLeft>>

\* startReservation (ai-funded-metering-repository.ts)
Start(r, seesLate) ==
  /\ ~lock[r].held
  /\ res[r].status = "reserved"
  /\ ~seesLate
  /\ res' = [res EXCEPT ![r].status = "in_flight", ![r].started = TRUE, ![r].late = FALSE]
  /\ UNCHANGED <<month, promoExpired, bal, grant, lock, addonLeft, ledger>>

\* releaseReservation, first half: SELECT ... FOR UPDATE on the reservation.
ReleaseBegin(r, cm, ce, seesLate) ==
  /\ ~lock[r].held
  /\ res[r].status = "reserved"
  /\ ~seesLate
  /\ lock' = [lock EXCEPT ![r] = [held |-> TRUE, month |-> cm, expired |-> ce]]
  /\ UNCHANGED <<month, promoExpired, bal, grant, res, addonLeft, ledger>>

\* releaseReservation, second half: balance row lock to commit.
ReleaseCommit(r) ==
  /\ lock[r].held
  /\ LET x == res[r]
         m == x.machine
         \* The clock was read in ReleaseBegin, before the row locks.
         cm == IF StaleClock THEN lock[r].month ELSE month
         ce == IF StaleClock THEN lock[r].expired ELSE promoExpired
         S1 == ResetMonth(Cur, m, cm)
         b == S1.bal[m]
         same == b.period = x.period
         S2 == IF b.reserved < x.hold \/ (same /\ b.mres < x.hold) THEN Fail(S1)
               ELSE [S1 EXCEPT !.bal[m].reserved = @ - x.hold,
                               !.bal[m].mres = IF same THEN @ - x.hold ELSE @]
         R2 == [res EXCEPT ![r] = Released(x)]
     IN /\ Commit(Reconcile(S2, R2, m, ce))
        /\ res' = R2
  /\ lock' = [lock EXCEPT ![r] = NoLock]
  /\ UNCHANGED <<month, promoExpired, addonLeft>>

\* releaseReservation rolled back (an error, or the caller went away).
ReleaseAbort(r) ==
  /\ lock[r].held
  /\ lock' = [lock EXCEPT ![r] = NoLock]
  /\ UNCHANGED <<month, promoExpired, bal, grant, res, addonLeft, ledger>>

\* releaseCustomerCharge (ai-funded-customer-charge-release.ts): give the hold
\* back, mark the request expired, never invent usage. Clock read after locks.
ReleaseCharge(S, R, r) ==
  LET x == R[r]
      m == x.machine
      b == S.bal[m]
      same == b.period = x.period
      S2 == IF ~S.ok \/ b.reserved < x.hold \/ (same /\ b.mres < x.hold) THEN Fail(S)
            ELSE [S EXCEPT !.bal[m].reserved = @ - x.hold,
                           !.bal[m].mres = IF same THEN @ - x.hold ELSE @]
      R2 == [R EXCEPT ![r] = ChargeReleased(x)]
  IN [S |-> Reconcile(S2, R2, m, promoExpired), R |-> R2]

\* cleanupOwnerCustomerCharges (ai-funded-customer-credit-cleanup.ts)
Cleanup(r) ==
  /\ ~lock[r].held
  /\ IsActive(res[r]) /\ res[r].late /\ ~res[r].chargeReleased
  /\ LET out == ReleaseCharge(Cur, res, r)
     IN Commit(out.S) /\ res' = out.R
  /\ UNCHANGED <<month, promoExpired, lock, addonLeft>>

\* finalizeReservation mode "conservative": usage unknown, release the customer.
ConservativeFinalize(r) ==
  /\ ~lock[r].held
  /\ res[r].status = "in_flight" /\ ~res[r].chargeReleased
  /\ LET out == ReleaseCharge(Cur, res, r)
     IN Commit(out.S) /\ res' = out.R
  /\ UNCHANGED <<month, promoExpired, lock, addonLeft>>

\* settleReservationInternal, prepaid branch (hold or usage, charge not released)
SettlePrepaid(r, a) ==
  /\ ~lock[r].held
  /\ LET x == res[r]
         m == x.machine
         cc == Min(a, x.hold)
         S1 == ResetMonth(Reconcile(Cur, res, m, promoExpired), m, month)
         b == S1.bal[m]
         pd == Min(cc, x.promoAlloc)
         ad == cc - pd
         same == b.period = x.period
         S2 == IF ~S1.ok \/ S1.grant.remaining < pd \/ b.credit < cc \/ b.promo < pd
                  \/ b.addon < ad \/ b.reserved < x.hold \/ (same /\ b.mres < x.hold)
               THEN Fail(S1)
               ELSE [S1 EXCEPT !.grant.remaining = @ - pd,
                               !.bal[m].credit = @ - cc,
                               !.bal[m].promo = @ - pd,
                               !.bal[m].addon = @ - ad,
                               !.bal[m].reserved = @ - x.hold,
                               !.bal[m].spent = IF same THEN @ + cc ELSE @,
                               !.bal[m].mres = IF same THEN @ - x.hold ELSE @,
                               !.ledger.debited = @ + cc]
         R2 == [res EXCEPT ![r] = Settled(x, a, cc, x.period)]
     IN /\ x.status = "in_flight" /\ x.mode # "postpaid" /\ ~x.chargeReleased
        /\ ~(x.mode = "hold" /\ x.late)
        /\ a <= (IF x.mode = "usage" THEN x.max ELSE x.hold)
        /\ Commit(Reconcile(S2, R2, m, promoExpired))
        /\ res' = R2
  /\ UNCHANGED <<month, promoExpired, lock, addonLeft>>

\* settlePostpaidUsage (ai-funded-postpaid-settlement.ts): postpaid requests,
\* and any request whose customer charge was already released.
SettlePostpaid(r, a) ==
  /\ ~lock[r].held
  /\ LET x == res[r]
         m == x.machine
         first == IF ~x.chargeReleased /\ x.late THEN ReleaseCharge(Cur, res, r)
                  ELSE [S |-> Cur, R |-> res]
         R1 == first.R
         S1 == Reconcile(ResetMonth(first.S, m, month), R1, m, promoExpired)
         b == S1.bal[m]
         src == Sources(S1, R1, m, promoExpired)
         charge == IF R1[r].chargeReleased THEN 0
                   ELSE Max(0, Min(Min(a, src.avail),
                                   Min(b.credit - b.reserved, Budget - b.spent - b.mres)))
         pa == Min(src.gAvail, charge)
         ad == charge - pa
         S2 == IF ~S1.ok \/ (~R1[r].chargeReleased /\ (src.throws \/ ad > src.addonAvail))
               THEN Fail(S1)
               ELSE [S1 EXCEPT !.grant.remaining = @ - pa,
                               !.bal[m].credit = @ - charge,
                               !.bal[m].promo = @ - pa,
                               !.bal[m].addon = @ - ad,
                               !.bal[m].spent = @ + charge,
                               !.ledger.debited = @ + charge]
         R2 == [R1 EXCEPT ![r] = Settled(R1[r], a, charge, b.period)]
     IN /\ x.mode = "postpaid" \/ x.chargeReleased
        /\ x.started
        /\ a <= x.max
        /\ x.status = "in_flight" \/ (x.status = "expired" /\ x.chargeReleased)
        /\ Commit(Reconcile(S2, R2, m, promoExpired))
        /\ res' = R2
  /\ UNCHANGED <<month, promoExpired, lock, addonLeft>>

\* grantCreditInTransaction, kind promotional_grant with a "promotion:" entry:
\* first call mints the grant, a replay on another runtime hands the rest over.
GrantPromo(m, ce) ==
  /\ ~ce
  /\ \/ /\ ~grant.exists
        /\ Commit([Cur EXCEPT !.grant = [exists |-> TRUE, machine |-> m, remaining |-> PromoAmount],
                              !.bal[m].credit = @ + PromoAmount,
                              !.bal[m].promo = @ + PromoAmount,
                              !.ledger.granted = @ + PromoAmount])
     \/ /\ grant.exists /\ grant.machine # m /\ grant.remaining > 0
        /\ ~\E x \in Rids : IsActive(res[x]) /\ res[x].promoAlloc > 0
        /\ LET n == grant.remaining
               from == grant.machine
               S1 == IF bal[from].credit < n \/ bal[from].promo < n THEN Fail(Cur)
                     ELSE [Cur EXCEPT !.bal[from].credit = @ - n,
                                      !.bal[from].promo = @ - n,
                                      !.bal[m].credit = @ + n,
                                      !.bal[m].promo = @ + n,
                                      !.grant.machine = m]
           IN Commit(S1)
  /\ UNCHANGED <<month, promoExpired, res, lock, addonLeft>>

\* grantCreditInTransaction, kind addon_grant
GrantAddon(m) ==
  /\ addonLeft > 0
  /\ addonLeft' = addonLeft - 1
  /\ Commit([Cur EXCEPT !.bal[m].credit = @ + AddonAmount,
                        !.bal[m].addon = @ + AddonAmount,
                        !.ledger.granted = @ + AddonAmount])
  /\ UNCHANGED <<month, promoExpired, res, lock>>

\* getRuntimeFundingSummary
Summary(m, cm, ce) ==
  /\ Commit(Reconcile(ResetMonth(Cur, m, cm), res, m, ce))
  /\ UNCHANGED <<month, promoExpired, res, lock, addonLeft>>

\* The wall clock.
MonthTurns ==
  /\ month = 0
  /\ month' = 1
  /\ UNCHANGED <<promoExpired, bal, grant, res, lock, addonLeft, ledger>>

PromoExpires ==
  /\ grant.exists /\ ~promoExpired
  /\ promoExpired' = TRUE
  /\ UNCHANGED <<month, bal, grant, res, lock, addonLeft, ledger>>

RequestDeadlinePasses(r) ==
  /\ ~res[r].late
  /\ IsActive(res[r]) \/ (res[r].status = "expired" /\ res[r].started)
  /\ res' = [res EXCEPT ![r].late = TRUE]
  /\ UNCHANGED <<month, promoExpired, bal, grant, lock, addonLeft, ledger>>

-----------------------------------------------------------------------------
Init ==
  /\ month = 0
  /\ promoExpired = FALSE
  /\ bal = [m \in Machines |-> [credit |-> 0, promo |-> 0, addon |-> 0, reserved |-> 0,
                                period |-> 0, spent |-> 0, mres |-> 0]]
  /\ grant = [exists |-> FALSE, machine |-> "nil", remaining |-> 0]
  /\ res = [r \in Rids |-> NoRes]
  /\ lock = [r \in Rids |-> NoLock]
  /\ addonLeft = AddonGrants
  /\ ledger = [granted |-> 0, debited |-> 0, expired |-> 0]

AuthorizeAny == \E r \in Rids, m \in Machines, mode \in Modes, max \in 1..MaxCost,
                   cm \in ClockMonths, ce \in ClockExpired : Authorize(r, m, mode, max, cm, ce)
StartAny == \E r \in Rids : \E s \in SeesLate(r) : Start(r, s)
ReleaseBeginAny == \E r \in Rids, cm \in ClockMonths, ce \in ClockExpired :
                     \E s \in SeesLate(r) : ReleaseBegin(r, cm, ce, s)
ReleaseCommitAny == \E r \in Rids : ReleaseCommit(r)
ReleaseAbortAny == \E r \in Rids : ReleaseAbort(r)
CleanupAny == \E r \in Rids : Cleanup(r)
ConservativeFinalizeAny == \E r \in Rids : ConservativeFinalize(r)
SettlePrepaidAny == \E r \in Rids, a \in 0..MaxCost : SettlePrepaid(r, a)
SettlePostpaidAny == \E r \in Rids, a \in 0..MaxCost : SettlePostpaid(r, a)
GrantPromoAny == \E m \in Machines, ce \in ClockExpired : GrantPromo(m, ce)
GrantAddonAny == \E m \in Machines : GrantAddon(m)
SummaryAny == \E m \in Machines, cm \in ClockMonths, ce \in ClockExpired : Summary(m, cm, ce)
RequestDeadlinePassesAny == \E r \in Rids : RequestDeadlinePasses(r)

Work ==
  \/ AuthorizeAny \/ StartAny \/ ReleaseBeginAny \/ ReleaseCommitAny \/ ReleaseAbortAny
  \/ CleanupAny \/ ConservativeFinalizeAny \/ SettlePrepaidAny \/ SettlePostpaidAny
  \/ GrantPromoAny \/ GrantAddonAny \/ SummaryAny
  \/ MonthTurns \/ PromoExpires \/ RequestDeadlinePassesAny

Next == Work

\* Requests and runtimes are interchangeable.
Symmetry == Permutations(Rids) \cup Permutations(Machines)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
\* Rules about money. Each one is a promise the ledger makes.

OnMachine(m, f(_), keep(_)) ==
  SumOf([r \in Rids |-> IF res[r].machine = m /\ keep(res[r]) THEN f(res[r]) ELSE 0], Rids)

HoldOf(x) == x.hold

\* Every microdollar of credit is explained by a ledger entry.
CreditMatchesLedger ==
  /\ SumOf([m \in Machines |-> bal[m].credit], Machines)
       = ledger.granted - ledger.debited - ledger.expired
  /\ \A m \in Machines : bal[m].credit = bal[m].promo + bal[m].addon
  /\ \A m \in Machines : bal[m].promo = IF grant.exists /\ grant.machine = m THEN grant.remaining ELSE 0

\* The reserved total is exactly the holds of the open requests.
ReservedMatchesHolds ==
  \A m \in Machines : bal[m].reserved = OnMachine(m, HoldOf, IsActive)

\* Open holds never exceed the credit that backs them.
HoldsAreBacked ==
  \A m \in Machines :
    /\ bal[m].credit >= bal[m].reserved
    /\ bal[m].addon >= AddonProt(res, m)
    /\ grant.exists /\ grant.machine = m => grant.remaining >= PromoProt(res, m)
    /\ ~(grant.exists /\ grant.machine = m) => PromoProt(res, m) = 0

\* A request is charged once, never above its hold, and never after its
\* customer charge was released.
ChargeIsCapped ==
  /\ ledger.debited = SumOf([r \in Rids |-> res[r].charged], Rids)
  /\ \A r \in Rids :
       /\ res[r].charged > 0 => res[r].status = "settled"
       /\ res[r].capOk

\* A request that was sent to the provider is never closed as unused.
StartedRequestsAreNotReleased ==
  \A r \in Rids : res[r].status = "released" => ~res[r].started

\* A usage-mode request is the owner's only open request.
OneUsageRequestPerOwner ==
  \A r \in Rids :
    IsActive(res[r]) /\ res[r].mode # "hold" =>
      \A x \in Rids \ {r} : ~IsActive(res[x])

-----------------------------------------------------------------------------
\* Rules about the monthly budget window.

InPeriod(m, p, x) == x.machine = m /\ x.period = p

\* This month's reserved counter is exactly the open holds taken this month.
MonthReservedMatchesHolds ==
  \A m \in Machines :
    bal[m].mres = SumOf([r \in Rids |->
      IF IsActive(res[r]) /\ InPeriod(m, bal[m].period, res[r]) THEN res[r].hold ELSE 0], Rids)

\* What a runtime is charged for a month, plus what it still holds for that
\* month, never exceeds the monthly budget.
BudgetIsHonored ==
  \A m \in Machines, p \in Months :
    SumOf([r \in Rids |->
        IF res[r].machine = m /\ res[r].status = "settled" /\ res[r].spendPeriod = p
        THEN res[r].charged ELSE 0], Rids)
    + SumOf([r \in Rids |->
        IF IsActive(res[r]) /\ InPeriod(m, p, res[r]) THEN res[r].hold ELSE 0], Rids)
    <= Budget

\* Every open hold can still be given back once its deadline passes.
\* (releaseCustomerCharge refuses, and cleanup keeps the hold forever, when the
\* month counter is smaller than the hold.)
HoldsCanBeReleased ==
  \A r \in Rids :
    IsActive(res[r]) =>
      LET b == bal[res[r].machine]
      IN b.reserved >= res[r].hold
         /\ (b.period = res[r].period => b.mres >= res[r].hold)

\* The budget window of a runtime never moves back to an earlier month.
MonthNeverMovesBack ==
  [][\A m \in Machines : bal'[m].period >= bal[m].period]_vars

=============================================================================
