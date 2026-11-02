# Default-app dependency security qualification

Tracking: [GTM-305](https://linear.app/matrix-os/issue/GTM-305/remediate-the-vanta-github-dependency-vulnerability-backlog).

## Problem and scope

Notes, Task Manager and App Gallery install their own dependency graphs from their Matrix build declarations. Root overrides do not qualify these locks. Authenticated npm audit baselines on 2 November 2026 report 10, 8 and 3 high advisories respectively; counts are per app graph, not unique CVEs. Update these three graphs without changing application source, production access or install semantics. Retain every functional lockfile. Old shell/mobile lock remediation remains separate.

## Outcome

Each app must accept a frozen standalone install, compile through its real declared build and report zero high/critical advisories. Preserve the existing seven-day quarantine in App Gallery and make the same quarantine explicit in Notes and Task Manager. Keep React on the current 19.2 patch line and keep Vite on major 6; refresh compatible Tiptap/editor and transitive patches.

## Validation and limits

The red baseline is the actual registry security audit against each original lock. The green check is the same audit against each updated lock, plus frozen installs and real TypeScript/Vite production builds. No mock package graph or source-string assertion substitutes for these checks. All checks use pnpm 10.33.4; builds use Node 26.0.0, satisfying the Node >=24 requirement. Qualification on the production Node version, hosted CI and independent current-head review remain gates before release.

No UI source, endpoint, persistence or authorization changes. Auth remains the injected Matrix bridge; these builds do not prove runtime CRUD, owner isolation or native/mobile parity. A live Matrix app smoke test remains open before review-ready status. No customer workspace or deployed app is modified.

Documentation deliverable: prepare a separate FinnaAI/matrix-os-site content/docs PR documenting the standalone bundled-app quarantine and frozen-install checks. Its content is prepared in the audit pack; site worktree implementation/publication remains pending. No public claim of audit clearance or new runtime behavior may be made from this lockfile maintenance.

## Release gates

Publish only after Hamed approves the specific push. Current-head CI, Greptile 5/5 and independent review are required; no merge or deployment is authorized. GitHub alerts require post-merge rescan; Vanta mirror is stopped and must not be treated as current upstream evidence. Branch bypasses and all emails remain unchanged/unsent.
