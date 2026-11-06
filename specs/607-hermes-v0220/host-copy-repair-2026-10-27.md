# Host runtime home staging repair

ENG-306 / PR2695 follow-up; local-only. The previous379118 diagnostic Host archive was recovered manually after a canonical copy failure and is not a release qualification.

## Failure and minimum repair

The original Linux x64 build failed while copying a Babel symlink under `home/apps/games/chess/node_modules/.pnpm` on an OrbStack host-bind filesystem. The exact leaf copy subsequently passed three bounded replays, so its transient ENOENT cause is unproven. Source/output were FUSE binds; native container scratch is overlayfs.

The reproducible packaging defect is copy-before-prune: an unreadable or transient build-only dependency store aborts a runtime release, even though the script immediately deletes that store. `copy-host-runtime-home.sh` now prunes real directories named node_modules before a NUL-delimited, nonrecursive find/tar stream copies the remaining tree. Existing post-copy cleanup remains. Symlinks are not followed or rewritten; runtime file/directory errors and archive errors remain fatal. No dependency version, admission rule, installer, account state or installed user directory changes.

The real build copy/cleanup entrypoint regressed red on the old command when node_modules was inaccessible. Final focused regressions: **126passed/0failed/0skipped across4files** (home copy5, Host bundle72, cloud-init47, staging2). Removing pipefail makes the producer-failure assertion fail even when extraction succeeds; restored source passes. Negative runtime file and directory reads still fail. Fixtures retain modes/dotfiles/empty directories/newline names/verbatim symlinks. Initial unreadable-directory fixture cleanup was repaired without weakening its assertion.

A short Linux x64/network-none/read-only-root/nonroot/1CPU probe used the actual helper on the preserved original home tree: exit0; **all1280runtime entries exactly match** the previous source/runtime manifest (path/type/mode/size/hash). Original source is read-only and retained. This is a copy component proof, not a complete successful Host build.

## Pending standard build and Hermes qualification

After Claude settings releases the heavy window, clone the new exact committed source from a read-only input into a native Linux working directory. Run the unchanged standard `bash scripts/build-host-bundle.sh` entrypoint once, with pinned Node24/pnpm10, public verified Clerk build input, separate task output and exact source SHA. Do not resume an old stage. Require exit0, archive/release SHA agreement and a network-disabled/read-only/nonroot import using the actual produced archive's Node/native payload. Retain first failure if this still fails; no retries concealing it.

Then qualify official Hermes e06df9c2 on actual PM Linux x64 pins from `pm/lock.json`: Node26.7.0/npm12.0.2/Python3.14.7+20260901/uv0.12.3; all+anthropic+mcp, actual TUI/web builders, canonical-root receipts, independent curated build artifact and full-vs-curated startup/rebuild/recovery. Every npm ci produces a new full input and requires fresh audited curation; never delete from installed owner directories. Full original package remains intact. No single-file admission exception is authorized or implemented.

Public-site documentation remains a separate required delivery step from the original plan, after final behavior is qualified; no unrelated site PR or publication occurs during this local-only repair. Current-head CI/Greptile, real provisioning/Sync Agent, permitted account/model/MCP and matching English client captures remain outstanding.

Evidence outside Git: `/Users/nighxxx/Documents/Codex/2026-10-15/task/eng306-curated-qualification-20261027/copy-root-cause/`.
