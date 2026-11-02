# Default-app dependency security qualification

Tracking: [GTM-305](https://linear.app/matrix-os/issue/GTM-305/remediate-the-vanta-github-dependency-vulnerability-backlog).

## Problem and scope

Notes, Task Manager and App Gallery install their own dependency graphs from their Matrix build declarations. Root overrides do not qualify these locks. Authenticated npm audit baselines on 2 November 2026 report 10, 8 and 3 high advisories respectively; counts are per app graph, not unique CVEs. Refresh these graphs and correct the JSON-array persistence fault exposed by their real-runtime qualification, without changing production access or install semantics. Retain every functional lockfile. Old shell/mobile lock remediation remains separate.

## Outcome

Each app must accept a frozen standalone install, compile through its real declared build and report zero high/critical advisories. Preserve the existing seven-day quarantine in App Gallery and make the same quarantine explicit in Notes and Task Manager. Keep React on the current 19.2 patch line and keep Vite on major 6; refresh compatible Tiptap/editor and transitive patches.

## Validation and limits

The red baseline is the actual registry security audit against each original lock. The green check is the same audit against each updated lock, plus frozen installs and real TypeScript/Vite production builds. No mock package graph or source-string assertion substitutes for these checks. All checks use pnpm 10.33.4; builds use Node 26.0.0, satisfying the Node >=24 requirement. Qualification on the production Node version, hosted CI and independent current-head review remain gates before release.

No UI source, endpoint or authorization changes. The existing gateway write path now serializes JS arrays explicitly only when current PostgreSQL column metadata identifies a JSON/JSONB destination. Native SQL arrays, objects, nulls, parameter binding, atomic batch writes and the existing compare-and-swap predicate retain their semantics. Metadata is read per array-bearing statement, without a stale schema cache; failed metadata lookup must prevent the mutation. Auth remains the injected Matrix bridge.

The 2 November demo smoke found empty collection values silently stored as objects and populated labels/checklists rejected with PostgreSQL JSON errors. A six-case real-PostgreSQL regression must fail on the original source and pass with the correction, including actual Task Manager producer/consumer round trips across independent connections. Assign the suite to the mandatory remaining-PostgreSQL CI inventory, whose runner rejects skipped or missing assertions.

| Actor / action | Observable completion | Boundary / surface |
|---|---|---|
| Owner creates a card with empty or populated labels/checklist | Real PostgreSQL returns arrays; Task Manager rehydrates the same values | Actual app producer, QueryEngine, AppDb, pg driver and independent reader |
| Owner edits, toggles and removes collection values | Values persist after full reload; no optimistic-only success | Real Matrix Web Desktop bridge and disposable demo app namespace |
| Batch importer or CAS client changes collections | Atomic batch results and exact snapshot winner remain correct | Real PostgreSQL; insert/update/batch/CAS paths |
| App uses a genuine SQL-array field or changes its type | Driver SQL-array semantics remain intact; fresh metadata handles JSON conversion | Real PostgreSQL; objects/nulls and special characters preserved |

Notes editing/pin/Markdown/reload and Gallery catalog/search/details/filters passed earlier on demo Node26.8.2. The canonical Gallery bundle was tested only with Hamed's specific approval and its original bytes restored. Task Manager must be rerun against the corrected gateway in a bounded, separately authorized demo test with rollback. No production release is authorized. Web Canvas, Electron Desktop and mobile parity/recording remain unqualified; one surface does not stand in for another. Reviewer approval is required for architectural N/A decisions.

Documentation deliverable: prepare a separate FinnaAI/matrix-os-site content/docs PR documenting standalone bundled-app quarantine/frozen-install checks and collection persistence through the Matrix bridge. Its initial content is prepared in the audit pack; site worktree implementation/publication remains pending. No public claim of audit clearance or deployed remediation may be made from source qualification.

## Release gates

Publish only after Hamed approves the specific push. Current-head CI, Greptile 5/5 and independent review are required; no merge or deployment is authorized. GitHub alerts require post-merge rescan; Vanta mirror is stopped and must not be treated as current upstream evidence. Branch bypasses and all emails remain unchanged/unsent.
