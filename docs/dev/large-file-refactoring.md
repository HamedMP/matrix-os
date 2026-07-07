# Large File Refactoring

Matrix OS should stay easy to review, test, and modify. Large files are allowed
only when they are intentionally generated, data-heavy, or a short-lived
transition during an active extraction stack.

## File Size Budget

Use these as review signals, not hard style-law:

| File size | Expected action |
|-----------|-----------------|
| <= 500 LOC | Preferred size for route composition, React containers, hooks, helpers, and focused tests. |
| 500-1000 LOC | Acceptable when the file has one clear responsibility and a local table of contents is still obvious. |
| 1000-2000 LOC | Needs an extraction plan in the PR body or a follow-up issue unless it is generated or fixture-heavy. |
| > 2000 LOC | Split before adding more behavior. If touching it, strongly prefer extracting a module first. |
| > 5000 LOC | Treat as refactor debt. Do not add behavior without also starting or extending a decomposition stack. |

The goal is not to chase line counts mechanically. The goal is that a reviewer
can answer "what owns this behavior?" without reading thousands of lines.

## Extraction Order

Prefer low-risk extractions before behavior changes:

1. Move pure helpers and constants into domain-named modules.
2. Move presentational React components out of stateful containers.
3. Move route families out of omnibus server files.
4. Move repeated test fixtures into `*-test-utils.ts`.
5. Split tests by behavior while keeping assertion text unchanged.

Avoid mixing extraction with logic changes. If behavior must change, put the
mechanical extraction in a lower stack layer and the behavior change in a later
layer.

## Entry Point Shape

Entry points should compose modules, not own the whole product surface:

- Platform `main.ts`: dependency wiring, middleware mounting, route composition.
- Gateway `server.ts`: server construction, shared middleware, route mounting.
- Shell container components: state orchestration plus child component wiring.
- Test root files: describe high-level behavior and import shared fixtures.

If an entrypoint crosses 500 LOC, check whether route groups, hooks, view
sections, schemas, or response builders can move into focused modules.

## Stacked PR Guidance

Use Graphite for large refactors. Good stack layers are:

1. Documentation and guardrails.
2. Pure helper extraction with focused tests.
3. Route/component extraction by one behavior family.
4. Test split for the moved behavior.
5. Follow-up cleanup after Greptile feedback.

Every stack layer should remain reviewable on its own and include exact
validation. Backend layers still need the required `Invariants` section from
`docs/dev/review-pipeline.md`.

## Review Checklist

Before opening a PR that touches a large file:

- Did this reduce or contain file size instead of increasing it?
- Is the new module name tied to domain behavior rather than generic "utils"?
- Are public exports minimal and tested?
- Did assertion text stay unchanged for mechanical test splits?
- Did you avoid moving unrelated code just to satisfy line count?
- Did the PR body explain any file that remains above 1000 LOC?

If the honest answer is "this PR made a large file larger," split the PR or add
a lower-layer extraction first.
