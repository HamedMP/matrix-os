# Stage 2 worktree CLI pilot

See [ENG-432](https://linear.app/matrix-os/issue/ENG-432/build-a-reusable-multi-worktree-devstack).

## Engineer workflow

Run `matrix devstack` and choose a Dev Computer and a linked Git worktree. On first use, the CLI claims an eligible operator-prepared slot, projects and synchronizes the worktree, and opens the owner-protected preview. A repeated invocation reuses the same binding. Use `--computer`, `--worktree`, and `--json` for scripts.

Run `matrix devstack sync`, `diff`, `status`, or `reset` from the worktree or pass `--worktree`. Sync forces a rescan and flush. Diff lists local changes and exclusions. Status checks the watcher, Mutagen session, and preview. Reset rematerializes the selected source projection and reconciles the receiver. For bounded regular-file conflicts, the trusted operator guard can back up the verified remote files so Mutagen can recover them. It rejects unknown, out-of-scope, or unsupported changes for manual review.

The local worktree is authoritative. The projection includes staged and unstaged file contents and eligible untracked source. Git metadata, dependency and build output, and sensitive paths are excluded. The path policy does not scan the contents of ordinary source files for credentials. The watch process persists across CLI invocations. Run sync after resuming a worktree that missed updates.

## Operator contract

The pilot adapter at `~/.matrixos/devstack-adapter` is an owner-only executable outside the worktree. It can invoke `node scripts/devstack/stage2-worktrees.mjs /absolute/private-config.json "$@"`. The config pins the computer, approved repository, private state directory, HTTPS preview origin, executables, and exact slot IDs, source endpoints, and preview paths. Deploy these values privately. The core adapter never accepts an upstream path, host, or port from an engineer's CLI input.

The guard executable receives an operation and an exact slot ID. It admits the current approved operator on claim, verifies the registered target, handles activation and rollback, checks owner-protected preview readiness, and opens the isolated browser route. Its repair and restore operations are bound to an operation ID and exact known conflict file digests. An operator must provision the isolated slot and its guard beforehand. A full host or unprepared slot can refuse enrollment. No general host provisioner is enabled.

A local lock serializes enrollment and projection. The private binding pins the canonical Git worktree identity, receiver, and preview URL. Each slot owns a separate Mutagen session. The receiver must be scoped to its own isolated source root. Keep writable runtime state, credentials and build artifacts outside the synchronization boundary. First-use migration from a narrower session pauses that verified writer before the full writer is activated.

## Qualification

Run the CLI and projection tests, then run the adapter integration test with `DEVSTACK_TEST_MUTAGEN` and `DEVSTACK_TEST_FLOCK` set to local binaries. The integration test uses temporary worktrees and receivers and a separate Mutagen daemon. Live acceptance additionally requires two independently authenticated browser previews, exact source receipts, and an installed-service invariance check.
