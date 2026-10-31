# ENG-298 — local integration plan (2026-10-27)

Ticket: https://linear.app/matrix-os/issue/ENG-298/codex-pinned-at-01561-on-customer-vpses-npm-i-g-openaicodex-lands-in-a
Existing PR: https://github.com/HamedMP/matrix-os/pull/2593

## Current base and scope

Resume the original worktree. Preserve ce625 and historical receipts/artifacts in
backup refs, patch and verified full bundle. Rebase onto origin/main
97f4bbec1cbbab5b71469db9054adae83437aa31. Main #2617/#2618 already installs and
qualifies0.162.1, aligns scope and preserves healthy newer versions without a
state marker. Keep that policy: do not replay the old candidate's0.163 promotion.
Protocol qualification records are retained without granting future compatibility.

1. Resolve rebase conflicts while preserving Main's version constants, scope
   digest/acceptance fixtures and existing minimum-version behavior.
2. Retain the single legacy/PM npm reconciler, external digest-safe Matrix
   default, non-root owner-env activation, recognized npm shim migration and
   explicit bundle copy. Preserve custom commands and operator overrides.
3. Demonstrate RED on real developer installer + tool-pack + helper subprocesses:
   after npm succeeds but required repair fails, the next startup skips repair.
   Fix it by retrying only the locked owner repair for a healthy existing CLI;
   do not reinstall or downgrade it. Exercise repeated failure and later recovery.
4. Run serial affected suites, relevant type checks, shell/Node syntax and pattern
   scan. Record actual failures separately from setup/permission limitations.
5. Seal a local exact HEAD and dependency handoff for Hermes2695. Keep the
   helper/owner-env source interface single-owned here. Do not rebase its branch.

## Downstream and acceptance

Hermes2695 currently targets oldce625 at376baeb01073193d7de7536023f0ee501bf01e39.
Its original author owns the upgrade, PM/extras/Python/auth work. It must replay
its own two commits onto the new frozen2593 local baseline and retain the shared
repair hook after PM/extras installation, rather than copying the reconciler.

Only local code and bounded verification are authorized. No push, CI dispatch,
external review request, merge, deployment, paid environment, new privilege,
account/provider use, Slack or GUI. Another Runtime task owns its own worktree,
processes and builds; no heavy concurrent build is started here.

Historical ce625 client/native0.163 evidence remains true for that historical
source. It does not qualify this rebased source. A new matching host/client
manifest, installed CLI/version/hash, supported real entry and English captures
remain required before human review. Public site documentation remains a separate
coordinated deliverable under the existing no-Private/no-publication boundary.
