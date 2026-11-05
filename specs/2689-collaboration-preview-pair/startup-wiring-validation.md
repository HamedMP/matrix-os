# Configured Platform startup checkpoint

[ENG-418](https://linear.app/matrix-os/issue/ENG-418) remains In Progress.
Configured source startup now mounts the internal composer. Protected automation,
Electron and real-user acceptance remain separate required work.

The existing customer dependency/store assembly is extracted before adding the
focused Preview startup call. Ordinary service behavior is retained. The private
pair context chooses provider/template ports and a dedicated store prefix; it
never inherits customer billing or automatic Preview activation callbacks.

The real Platform startup test runs through app composition with actual Postgres
and real service construction. Before the fix, configured pair routes were absent
from app dependencies, and app-composition failure never closed the newly opened
primary pool. Both outcomes now pass. Google secret resolution and object storage
are explicit fixture ports; preflight checks are fixture functions and no listener
is opened. This is startup wiring coverage, not protected-cloud qualification.

The scoped worker starts only after app creation on the existing worker-enabled
path. Repeated start does not duplicate a pass. Stop prevents new work; close
awaits the active pass before destroying its owned target pool. Primary and target
owners register cleanup before later startup can fail. Failure drains them in
reverse order; normal shutdown closes the target before the primary. A failed
cleanup registration also closes the real target, including an uninitialized pool.
Injected source/fixture pools remain usable. No credential or process-global
organization state is introduced.

A target-outage test retires the exact labeled owned provider server through the
real durable deletion consumer while projected/cloud confirmation remains pending.
Its fixture lease stays held; no new server is created. The bank-off test retains
authenticated reporting. Admission/activation still check current identity, actual
DB isolation, pinned profile and bounded funding before writes/dispatch.

Combined qualification passed125/125 tests across13 suites, zero skips/unhandled
errors, exit0. The lifetime subset passed15/15 across four files. Strict SQL
inventory is80 files. All eight native TypeScript projects passed; final platform-only credential edits
and the isolated reader parent also passed targeted platform checks. Source scan
results are recorded in this layer's PR. T015 is complete at the code/wiring
checkpoint; T016/T033/T041 remain open.
The initial wrong background-worker variable in a primary-pool fixture was
corrected and the regression repeated before implementation; only the explicit
worker-disabled run is counted. Earlier fixture/pool-teardown failures are not green.

No paid or cloud resource, customer computer, sharing grant or membership changed.
There is no normal-login product result or live visual evidence for any surface.
T016/T033 stay open, including durable request intent before publication so
cancellation before candidate admission can be recovered safely. T041 requires
reviewed real isolation/fixtures/funding and actual target access. No merge or
production deployment is authorized by this checkpoint.
