# S4: hydrate, flush, and the kernel SQLite snapshot

**Verdict: pass** against "measured for small, medium, and large homes; snapshot opens
cleanly after a kill", after a Linux rerun. The first run, on a Mac, was a partial pass.

Code and raw data: branch `spike/2691-s4` at `b63e185ec`, directory `spikes/2691-s4/`.
Full report: `spikes/2691-s4/results/s4-hydrate-flush-report.md` on that branch.

Environments:

- Mac: Apple M4 Pro, 12 cores, MinIO and Postgres 16 in OrbStack.
- Linux rerun (2026-11-11): x86_64, 32 cores, local NVMe, a MinIO fork (`pgsty/silo`) and
  Postgres 16 in Docker. The host was shared with CI. Load average was 3 to 52, so treat
  Linux numbers as noisy upper bounds. Differences under about 30 % are not meaningful.
- Every object request went through a delay proxy: 0 ms ("local") or 20 ms (about a
  real region). Nothing was measured on an idle 1 vCPU machine.

## Fixtures

| Home | Files | Synced bytes |
| --- | --- | --- |
| small | 690 | 51.6 MB (template only) |
| medium | 5,038 synced | 236 MB |
| large | 49,494 | 2.44 GB (slightly above the 2 GiB home limit) |

## Status of each measurement

| Measurement | Status |
| --- | --- |
| SQLite SIGKILL, 5 methods x 30 kills | Final (Mac) |
| Proposed layouts (perfile, packs, tar), small and medium, 0 and 20 ms | Final (Mac) |
| Proposed layouts, large, 0 and 20 ms | Final (Linux) |
| Minimal boot set hydrate, 3 homes | Final (Mac) |
| Gateway boot time | Final for each host; not measured on an idle 1 vCPU machine |
| Boot-time `git init` cost | Final for the Mac host |
| Existing mirror, small and medium | Final (Linux) |
| Existing mirror, large | Bounded (Linux): flush measured once, hydrate did not finish |
| Owner Postgres dump and restore, 53 MB and 525 MB | Final (Linux), 1 vCPU client |
| Template-over-owner-file ordering hazard | Tested (Linux): reproduces |

## Key measured numbers

Median / worst, seconds, n = 5 unless noted.

**Existing mirror (today's code).**

| Home | Delay | Full flush | Hydrate | `stop()` after 100 changes |
| --- | --- | --- | --- | --- |
| small | 20 ms | 47.5 / 48.0 | 15.9 / 15.9 | 10 s deadline, 71-72 of 100 landed |
| medium | 20 ms | 396 / 446 | 145 / 233 | 10 s deadline, 32-56 of 100 landed |
| large | 0 ms | 2,538 (n = 1) | did not report ready within 2,700 s | not run |

Every changed file costs about 5 object requests plus a whole new manifest. The pull
rewrites `state.json` once per file, so hydrate is O(N^2) in file count. `stop()` has a
hard-coded 10 s deadline. The existing path cannot serve a medium or large home.

**Proposed layouts, large home, 20 ms (Linux).**

| Op | perfile | packs | tar |
| --- | --- | --- | --- |
| hydrate | 45.5 / 50.7 | 17.9 / 19.1 | 11.3 / 18.0 |
| full flush | 44.7 / 45.4 | 21.0 / 21.5 | 12.6 / 21.8 |
| flush, 1 file | 2.1 / 2.7 | 3.4 / 4.5 | 12.0 / 13.0 (re-uploads 2.44 GB) |
| flush, 5,000 files | 5.5 / 8.2 | 6.2 / 7.3 | 12.1 / 13.2 |

Every non-idle perfile or packs flush on the large home uploaded the whole manifest,
about 16 MB. For medium at 20 ms, packs hydrate in 1.25 s against 6.25 s per-file.

**Kernel SQLite (`system/matrix.db`, WAL mode).**

| Method | Clean restores out of 30 kills |
| --- | --- |
| Naive copy of the file | 0 |
| Copy db, then `-wal` (about what the mirror does today) | 2 |
| `VACUUM INTO` from a separate read-only connection | 30 |
| Backup API, one unbounded step | 27 |

**Owner Postgres (1 vCPU client, custom format).** Dump 0.49 s and restore 0.55 s for
53 MB; dump 2.64 s and restore 3.64 s for 525 MB. The synthetic rows compress about
15:1, so real dumps are larger (inferred).

**Wake path.**

- Gateway boot to `/health`, Mac: 2.0-4.0 s warm, 3.0-5.2 s cold transpile cache.
- Gateway boot, Linux pinned to one CPU under load 40-50: 11.1 s warm, 15.2 s cold. About
  4.25 s of that is a fixed terminal-runtime retry before listen
  (`agent-session-manager.ts`, delays 250, 1,000, 3,000 ms). Without it the warm boot
  would be about 7 s (inferred).
- Boot-time `git init` when `.git` is missing (after every hydrate today): small 1.8-2.2 s,
  medium 6.5-8.0 s, large 65-92 s. `.git` for large is 1.4 GB.
- The gateway reads about 275 files, 4.9 MB, at boot, first page, and first chat prompt.
  Hydrating only that set as one archive object took 0.23-0.64 s at 20 ms for all three
  homes.

**Ordering hazard.** On a fresh disk, `ensureHome` runs before the mirror pulls. If the
home directory is absent, the whole template is copied and all four edited owner files
stay at the template version; the owner's bytes go only into the local conflict store,
which a cache-only disk loses. If the home exists but is empty, `system/soul.md` still
loses, because it is not in `USER_OWNED_TEMPLATE_FILES`. This also affects VPS restores
today. Not tested: whether a later local edit then overwrites the owner's remote version.

## Inferred, not measured

- Large perfile hydrate on a real network: bytes-bound at 10-20 s for packs at
  100-200 MB/s.
- Any 1 vCPU number: boot, rebuild, and hydrate are expected to be slower.
- Agent turns on a large home wait 10-20 s for full fill with lazy hydrate.
- Upload of an uncompressed 525 MB dump: about 5 s at 100 MB/s.

## What changes

- Wake target (5 s, ready after the boot set) is separate from the 90 s start ceiling.
- Readiness waits for an eager boot-set archive written at every flush. Agent turns and
  the terminal wait for full hydrate.
- Container profile skips boot-time `git init`.
- Batched flush: one manifest per flush, a flush barrier, and manifest sharding or deltas.
- Layout: files of 256 KiB or less in about 16 MiB ustar packs, larger files as blobs;
  needs repack GC. This changes the mirror pull path and `ManifestEntrySchema` on both
  substrates. `matrix-restore.sh` restores only Postgres today.
- `VACUUM INTO` for `matrix.db`; exclude `system/matrix.db*` from file sync.
- Final-flush deadline from configuration (120 s), replacing the hard-coded 10 s.
- Stop order: files, then manifest commit, then the Postgres dump, because the manifest
  pointer lives in owner Postgres. Dump keys need seconds plus generation; today's
  minute-resolution names can collide.
- File-count cap of 50,000, matching the mirror state cap.
- Terminal-runtime retry moves off the gateway listen path; the image ships prebuilt JS.
- Fix the ordering hazard and add `system/soul.md` to the user-owned list.
- Bulk hydrate should use presigned URLs; today the broker proxies every byte.
