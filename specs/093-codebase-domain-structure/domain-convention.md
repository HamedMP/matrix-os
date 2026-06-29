# Matrix Domain Convention

The reusable rulebook referenced by `spec.md`. Once adopted, this content moves to a permanent home (e.g. `docs/dev/domain-structure.md`) and is linked from `CLAUDE.md`.

The goal is the **zoom property**: the system is understandable at every altitude, and each level is *complete* at that level without zooming in.

| Altitude | Artifact | Length |
|----------|----------|--------|
| 10,000ft | `CLAUDE.md` / repo `CONTEXT.md` | exists |
| 1,000ft  | per-package `ARCHITECTURE.md` | ~1 page |
| 500ft    | per-domain `DOMAIN.md` | 1–2 pages |
| 100ft    | the code | — |

---

## 1. Three categories

Every file belongs to exactly one category. The category decides where it lives.

| Category | Lives in | What it is | Litmus test |
|----------|----------|-----------|-------------|
| **App / composition** | `src/` root + `src/routes/` | Entry points, server bootstrap, route wiring, DI. **No business logic.** | "It wires things together and composes domains." |
| **Domain** | `src/domains/<name>/` | A self-contained capability: its rules, contracts, and implementation. | "It enforces a business rule or implements a user capability." |
| **Shared / infra** | `src/_shared/` (intra-package) or `packages/*` (cross-package) | Purely technical plumbing reused across domains. | "It is generic and useful to multiple domains, and contains no domain rules." |

**The one-way rule:** `app → domains → _shared`. `_shared` never imports a domain. The app root never holds business logic. If you're tempted to add a rule to `_shared`, it belongs in a domain.

---

## 2. Domain folder anatomy

```
src/domains/sessions/
├── DOMAIN.md            # purpose, public surface, dependencies, decision log
├── index.ts            # THE public entry — the only thing other domains import
├── routes.ts           # HTTP/WS handlers for this domain (if any)
├── ops.ts              # the domain operations (business logic)
├── store.ts            # persistence (Kysely/Postgres) for this domain
├── types.ts            # contracts + Zod schemas (the "shared" of this domain)
└── <feature>.ts        # supporting modules, co-located
```

Not every domain needs every file — domains are **asymmetric**. A read-only domain may be just `index.ts` + `types.ts` + `ops.ts`. Co-locate tests next to code (`ops.test.ts`) per the existing Superset-style pattern Matrix already uses in places.

**Internal vs public:** anything not re-exported from `index.ts` is private to the domain. Other domains import `domains/git`, never `domains/git/git-sync` internals.

---

## 3. Module export style (the opencode namespace pattern)

opencode's most copyable code convention: **each domain module self-exports a namespace**, so call sites read with their context intact.

```ts
// domains/sessions/index.ts
export * as Sessions from "./ops"
export * as SessionStore from "./store"
export type { Session, SessionId } from "./types"
```

```ts
// consumer in another domain or the app layer
import { Sessions } from "../sessions"          // not deep, not aliased
const s = await Sessions.create({ ... })
```

Rules (adopted from opencode, reconciled with Matrix's existing style):
- **No star imports** (`import * as Foo`) and **no aliased imports** (`import { x as y }`). Import the module's own exported namespace by name.
- **Happy-path-first**: the main exported function reads as the success path; push validation/branches into small helpers *below* it.
- **Don't pre-extract single-use helpers.** Inline unless reused, or it names a real concept (`requireConfig`, `resolveWithinHome`).
- Prefer `const` + early returns over `let` + reassignment; avoid `else` after a return.
- These are *guidelines for new and moved code*, not a mandate to rewrite working logic during a migration PR.

> Matrix's existing hard rules still win where they overlap (e.g. **no bare `catch`** — opencode's "avoid try/catch" yields to Matrix's "every catch must check error type and log").

---

## 4. Dependency rules

1. Domain → domain dependencies are **allowed but must be directional and acyclic**.
2. They are **declared** in the dependent domain's `DOMAIN.md` and **enforced** by `check:patterns`.
3. A domain imports another only via its public `index.ts`.
4. `_shared` and the app root are not domains and are exempt from (1)–(3), subject to the one-way rule in §1.

Example (gateway, illustrative):
```
apps      → files, git, _shared
sessions  → _shared
workspace → sessions, git, files, _shared
review    → sessions, workspace, _shared
social    → _shared
```
Cycles (e.g. `sessions ⇄ workspace`) are violations — break them by moving the shared piece down into `_shared` or into a lower domain.

---

## 5. Enforcement: the `check:patterns` boundary rule

Add one rule to the existing `scripts/review/check-patterns.sh` suite (no new dependency — the script is already wired as `bun run check:patterns`, with a `bun run check:patterns:diff main` variant for changed-files-only). It scans `src/domains/*` and fails on:

- **Deep cross-domain imports** — an import that resolves into `domains/<other>/<not-index>`. Legal: `domains/<other>` or `domains/<other>/index`.
- **Import cycles** — build the domain→domain edge list from imports; fail if a cycle exists.
- **Upward imports from `_shared`** — any file under `_shared/` importing from `domains/`.

Output format matches the existing scanner: `path:line  <rule>  <message>`. Runs in CI alongside the current pattern checks. (A heavier tool like `dependency-cruiser` is deliberately deferred; revisit only if this proves too weak — see Out of Scope in `spec.md`.)

---

## 6. `DOMAIN.md` template

```markdown
# Domain: <name>

**One-liner**: <what capability this owns, in a sentence>

## Public surface
What `index.ts` exports and what each export is for. This is the contract other
domains and the app layer rely on.

## Source of truth
Which store/table/file is canonical for this domain's state, and how divergence
is reconciled. (Mirrors the PR "Invariants" section.)

## Dependencies
- `domains/<x>` — why
- `_shared/<y>` — why
(Must match actual imports; check:patterns + docs-drift verify this.)

## Notes / invariants
Non-obvious constraints, concurrency/atomicity expectations, deferred scope.

## Decision Log
**YYYY-MM-DD: <decision>** — <rationale>
```

## 7. `ARCHITECTURE.md` template (per package)

```markdown
# <package> Architecture

## Golden path
The one main flow everything hangs off (entry → core → exit), in a few lines.

## Domains
| Domain | Purpose | Depends on |
|--------|---------|-----------|
| ...    | ...     | ...        |

## Dependency graph
<the allowed arrows, ASCII or list>

## Decision Log
...
```

Keep `ARCHITECTURE.md` to ~1 page. Principle: **if it's obvious from the code, don't document it.**

---

## 8. Docs stay in sync

Two lightweight checks (can start as review-checklist items, later scripted):
- **`/sync-domain <domain>`** (proposal, not auto-write): scan a domain's exports/imports, propose `DOMAIN.md` updates.
- **`verify-docs`**: flag drift — `DOMAIN.md` dependencies that don't match actual imports; undocumented public exports.

---

## 9. When a domain folder graduates to a package

Default is **folder**. Promote to a real `packages/*` workspace package only when **all** hold:
1. It is imported by **more than one runtime** (e.g. both gateway and shell, or gateway and cli).
2. It has an **independent release/versioning** need.
3. Its public surface is **stable** (churn would make a package boundary painful).

Until then, a folder gives ~80% of the benefit at ~0% of the build cost. (opencode keeps ~35 domains as folders in one package and only splits genuinely separate runtimes — tui, sdk, server, desktop, plugin — into packages.)

---

## 10. What this convention deliberately is NOT
- Not a package-per-domain explosion.
- Not TypeScript project references everywhere.
- Not a rewrite of working code — migrations are mechanical moves.
- Not a change to the top-level `packages/*` layout, which already follows the layer-driven model and is fine.
