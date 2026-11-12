# Keep scratch-project sharing Git probes within their workspace

Tracking: [ENG-367](https://linear.app/matrix-os/issue/ENG-367/fix-first-click-project-sharing-and-restore-organization-picker), parent ENG-29.

## Evidence and intended behavior

On installed v2026.10.29-1919, the owner's signed project inventory GET returns
HTTP 200 with `chat_root_unavailable`. Gateway logs record `Chat root Git probe
failed RangeError`. Read-only diagnostics confirm the registered scratch root
exists, belongs to the owner, has no Git metadata, and Git discovers the Matrix
home as an ancestor repository. The status probe can therefore exceed its
64-KiB output cap while inspecting files outside the project.

Scratch creation deliberately makes a directory without initializing Git, and
the inventory already intends to support non-Git projects. Confirm that Git's
reported top-level directory is the canonical execution root before requesting
branch or status. A different ancestor repository means no project Git metadata;
the Chat stays ready. Genuine project repositories and Git-file worktrees keep
their existing branch and dirty indicators. Unexpected probe failures remain
blocked, and the output/time limits remain enforced.

## Authority, wiring and failure boundaries

The existing signed scope/owner-runtime inventory route, caller ownership,
current organization membership and canonical Chat execution-root resolution
remain authoritative. No endpoint, grant, permission, scope generation, project
path or persistent state changes. The Git probe is optional metadata, never
authorization or a reason to inspect the parent's files. It adds one fixed-argv
read-only Git command with the existing timeout and output cap; no network,
unbounded registry or new temporary files are introduced in production.

| Existing entry point | Authentication and authority | Changed behavior |
| --- | --- | --- |
| GET scopes/:scopeId/project/inventory | Verified scope owner or signed owner-runtime session, matching owner/runtime/organization and current membership | Bound optional Git metadata to the canonical Chat workspace |

The Git metadata may change during ordinary owner Git operations; it is a bounded
readiness snapshot, not transaction authority. Canonical workspace/source checks
and publication revision/inventory checks stay intact. A true unexpected Git
error remains fail-closed. No retry or permission fallback is added.

## Tests and surfaces

Write failing regressions using real Git, the actual scratch project manager,
the canonical execution-root resolver and the owner Chat database fixture. Cover
an ancestor branch, a parent status larger than 64 KiB, a genuine project repo
and a Git-file worktree. Run inventory and relevant real-Postgres collaboration
qualification, typecheck and production/E2E gates.

This is owner-runtime metadata behavior shared by Web Canvas, Web Desktop,
Electron Desktop, Web Mobile and Native Mobile clients; no renderer changes.
The requester waived visual/Slack evidence; do not claim exact-candidate live
publication or member prompts without the separate QA-sharing authorization.
Platform/collaboration owner review is recommended. Prepare a separate public
documentation follow-up in `FinnaAI/matrix-os-site` explaining that project Git
readiness describes the project's own workspace; keep private incident details
out of public docs. This work is independent of the organization-selection PR.
