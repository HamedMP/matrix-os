# Required Postgres qualification budget

ENG-418 adds required real-Postgres suites to the existing collaboration lane.
[Run41112133779](https://github.com/HamedMP/matrix-os/actions/runs/41112133779)
on the unchanged #3039 head selected67 files: seven nine-file batches followed by
four files. The job started19:04:34 UTC; its last passing file summary arrived
19:14:29, about595 seconds later. It was cancelled19:14:30 at the10-minute limit
before job/report upload completion. #3040 selected71 files and also timed out.
The later startup checkpoint selects80 files. None of those cancellations proves
a product test failure or a qualified passing job.

Increase only collaboration-postgres to30 minutes to cover the expanded inventory
with margin. Keep the funded lane's existing10-minute bound, exact-source
checkout, services, selection, prerequisite build, reports and aggregate gates.
The existing workflow contract test now requires margin above the actual595-second
observation plus two minutes for completion/upload instead of freezing both
independent lanes to the same duration. It does not assert the literal new value.

The regression failed at600 seconds versus a715-second minimum. After the workflow
change,46 tests across three script suites passed with exit0. The full required
GitHub job must still execute and pass before CI qualification is claimed.
No production code, authorization, dependency, runtime or customer state changes.
This fix belongs in foundation PR #3028 so all native descendants inherit it;
restack without moving the frozen trunk base.
