#!/usr/bin/env python3
"""Prove that each rule can fail.

Each mutant is one small edit to a copy of the model that mirrors one
plausible mistake in the ledger code. TLC must then report the named rule as
broken. A mutant that no longer applies, or that TLC does not catch, fails
this script: fix the model or the mutant, never delete the rule.
"""
import pathlib, subprocess, sys, tempfile, shutil

HERE = pathlib.Path(__file__).resolve().parent
MODEL = HERE / "model"

# (name, config, rule that must break, text to find, replacement, the code mistake it mirrors)
MUTANTS = [
    ("handoff-keeps-source-credit", "TwoRuntimes", "CreditMatchesLedger",
     "ELSE [Cur EXCEPT !.bal[from].credit = @ - n,\n                                      !.bal[from].promo = @ - n,",
     "ELSE [Cur EXCEPT !.bal[from].credit = @,\n                                      !.bal[from].promo = @,",
     "grantCreditInTransaction hands a promotion to another runtime without debiting the source balance"),
    ("charge-release-keeps-hold", "OneRuntime", "ReservedMatchesHolds",
     "            ELSE [S EXCEPT !.bal[m].reserved = @ - x.hold,",
     "            ELSE [S EXCEPT !.bal[m].reserved = @,",
     "releaseCustomerCharge marks the request expired but does not give the hold back"),
    ("expiry-ignores-open-holds", "OneRuntime", "HoldsAreBacked",
     "      retired == g.remaining - PromoProt(R, m)\n  IN IF ~S.ok \\/ ~(g.exists",
     "      retired == g.remaining\n  IN IF ~S.ok \\/ ~(g.exists",
     "reconcileExpiredPromotionalCredit retires an expired grant without activePromotionalProtection"),
    ("settle-charges-above-hold", "OneRuntime", "ChargeIsCapped",
     "         cc == Min(a, x.hold)\n         S1 == ResetMonth(Reconcile(Cur, res, m, promoExpired), m, month)",
     "         cc == a\n         S1 == ResetMonth(Reconcile(Cur, res, m, promoExpired), m, month)",
     "settleReservationInternal drops Math.min(actualCostMicrousd, reserved) for usage-mode requests"),
    ("admission-skips-slot-check", "OneRuntime", "OneUsageRequestPerOwner",
     "        /\\ ~Conflict(res, mode)\n", "",
     "authorize admits without findConflictingActiveReservation"),
    ("window-moves-back", "OneRuntime", "MonthNeverMovesBack",
     "  ELSE [S EXCEPT !.bal[m].period = Max(@, p),\n                 !.bal[m].spent = IF S.bal[m].period >= p THEN @ ELSE 0,\n                 !.bal[m].mres = IF S.bal[m].period >= p THEN @ ELSE 0]",
     "  ELSE [S EXCEPT !.bal[m].period = p,\n                 !.bal[m].spent = IF S.bal[m].period = p THEN @ ELSE 0,\n                 !.bal[m].mres = IF S.bal[m].period = p THEN @ ELSE 0]",
     "advanceMonthWindow writes the caller's month even when the window is already newer (the ENG-576 bug)"),
    ("hold-keeps-callers-month", "OneRuntime", "MonthReservedMatchesHolds",
     "               !.period = b.period]]", "               !.period = cm]]",
     "authorize stores its own clock's month as the hold's period_start, not the window the hold was counted in"),
    ("start-skips-row-lock", "OneRuntime", "StartedRequestsAreNotReleased",
     "Start(r, seesLate) ==\n  /\\ ~lock[r].held\n", "Start(r, seesLate) ==\n",
     "startReservation stops waiting for the reservation row lock that an open releaseReservation holds"),
]

def run(tlc, workdir, config):
    out = subprocess.run(["java", "-XX:+UseParallelGC", "-cp", tlc, "tlc2.TLC", "-workers", "auto",
                          "-config", f"{config}.cfg", "-metadir", str(workdir / "states"), "FundedLedger.tla"],
                         cwd=workdir, capture_output=True, text=True).stdout
    return out

def main():
    tlc = sys.argv[1]
    source = (MODEL / "FundedLedger.tla").read_text()
    failed = 0
    for name, config, rule, find, replace, mirrors in MUTANTS:
        if source.count(find) != 1:
            print(f"FAIL  {name}: the text this mutant edits is not in the model exactly once")
            failed += 1
            continue
        with tempfile.TemporaryDirectory() as tmp:
            work = pathlib.Path(tmp)
            (work / "FundedLedger.tla").write_text(source.replace(find, replace))
            shutil.copy(MODEL / f"{config}.cfg", work)
            out = run(tlc, work, config)
        # TLC stops at the first broken rule; a month mutant may break a sibling month rule first.
        month = {"MonthReservedMatchesHolds", "BudgetIsHonored", "HoldsCanBeReleased", "MonthNeverMovesBack"}
        accepted = month if rule in month else {rule}
        if any(f"{r} is violated" in out for r in accepted):
            print(f"ok    {name}: {rule} breaks, as it must  ({mirrors})")
        else:
            failed += 1
            broke = [line for line in out.splitlines() if line.startswith("Error:")][:1]
            print(f"FAIL  {name}: expected {rule} to break, TLC said: {broke or 'no error'}")
    sys.exit(1 if failed else 0)

if __name__ == "__main__":
    main()
