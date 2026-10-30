# Pre-merge runtime safety

The approved stack was reviewed again before landing, including the six shared
files changed on main after the frozen source base. Preserve main's successful
Codex/Claude catalog invalidation hooks, exact Terminal viewer pings, receipt-bound
UI refresh and self-contained Host dependency installation.

## Publication and PM collection

The original pair of renames exposed a missing canonical checkout. The pinned
v0.22.0 PM orphan collector could then remove that checkout's selected facts and
generations. Holding only the checkout lock did not exclude PM operations, and
an ephemeral installation lock alone cannot protect the gap after process death.

Publication and rollback now exchange directories atomically and hold the exact
per-checkout PM installation lock. Unsupported atomic exchange fails closed.
The journal recovers the original inode from either the staging or backup path,
checks current PM facts, and retains source, failed inputs and audit history.
Legacy missing-root recovery cannot guarantee against a collector already running
from an older gap; missing or changed facts refuse successful recovery.

## Repeat installation

Official upstream completion reuses Node dependencies but refreshes completion
stamps. A previously curated checkout therefore remained missing the omitted
member while no longer matching its recorded digest, rejecting every retry.

Before upstream writes, the installer explicitly prepares a fresh full working
copy from the verified retained original. It checks the curated source, full
backup and copy digests, records fresh current PM facts under lock, and exchanges
atomically. The old complete audited backup stays unchanged. Once upstream owns
its working copy, interrupted Git/npm stages may retry; publication still rejects
incomplete or changed source under the unchanged full admission rules.

## Verification

- Original publication reproduced the selected-state loss with the actual pinned
  upstream collector; the corrected publisher preserves the canonical directory,
  facts and selected generation.
- 38 real-filesystem cases cover full input retention, PM writer exclusion,
  rollback, process death on both sides of backup archival, interrupted preparation,
  repeated installation, partial upstream Git/npm stages and changed PM selection.
- macOS and isolated Linux x64 pass all 38 cases. Linux uses no network, a non-root
  user and a read-only root. An initial 256 MiB fixture filesystem correctly
  refused the unchanged 4.5 GiB rollback reserve; a bounded larger fixture was used.
- 57 targeted installer, Codex npm/update/retry and staging tests pass. The expanded
  artifact suite took 44.3 seconds under x64 emulation, so its process/test deadlines
  are now 90/95 seconds; no assertions or safety thresholds were weakened.
- Fresh published-head CI and Greptile are required after this correction. Earlier
  approvals, CI and Preview evidence remain bound to their original source SHAs.

This does not change default installation policy, owner credentials, runtime
permissions, live services or Main. Existing installer-log access and Custom/
Browser MCP acceptance limitations remain separately documented in ENG-306.
