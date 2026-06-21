# Domain Documentation Convention

Use `DOMAIN.md` to make product-domain boundaries explicit for humans and coding agents. A domain document should explain what the domain owns, what it depends on, and which invariants reviewers must preserve.

Root `DOMAIN.md` defines the convention. Package or domain directories may add their own `DOMAIN.md` when they own non-trivial business behavior.

## Where Domain Docs Live

Preferred locations:

- `packages/<package>/DOMAIN.md` for package-wide domain rules.
- `packages/domains/<domain>/DOMAIN.md` if/when nested domain packages are introduced.
- `shell/src/<domain>/DOMAIN.md` only for renderer-specific domain behavior that has not yet moved to a package.
- `home/apps/<app>/DOMAIN.md` for first-party default apps with durable app-specific data.

Do not create duplicate domain docs for the same source of truth. Link to the canonical document instead.

## Required Sections

Each non-root `DOMAIN.md` should include:

```markdown
# <Domain Name>

## Scope
- What this domain owns.
- What is explicitly out of scope.

## Source Of Truth
- Canonical files, Postgres tables, external services, or platform rows.
- Which caches or UI stores are derived.

## Public API
- Exported modules, route registration helpers, schemas, commands, or bridge methods other code may use.
- Internal paths that other packages must not import.

## Auth And Trust Boundaries
- Auth source of truth.
- Inputs requiring validation.
- Error redaction policy.

## Concurrency And Recovery
- Transaction/lock scope.
- Optimistic concurrency rules.
- Acceptable orphan states and cleanup policy.

## Tests
- Focused tests that must run for domain changes.
```

## Boundary Rules

- Public exports should be intentional. Avoid deep imports from another domain's `src/internal`, route files, stores, or test helpers.
- Route handlers validate HTTP shape and auth, then call domain services. They should not become the domain model.
- Shell components render domain state and call public APIs. They should not duplicate source-of-truth rules from services.
- Domain services may depend on repositories and injected infrastructure, but they should not create hidden global state.
- Any in-memory registry must document its cap, eviction, and shutdown behavior in the owning domain doc or adjacent code.
- Any external fetch must document timeout and SSRF posture when URLs can be user-controlled.

## Extraction Sequence

Use this order for safe domain extraction:

1. Write `DOMAIN.md` for the current code in place.
2. Add a narrow public API or barrel for existing imports.
3. Move pure schemas/types/helpers first.
4. Move repository/service code after tests cover source-of-truth and failure modes.
5. Move route adapters last, preserving endpoint behavior.
6. Update `ARCHITECTURE.md`, specs, and public docs when ownership changes.

Avoid compatibility shims unless external consumers, persisted data, or shipped behavior require them.

## PR Checklist

For a PR that adds or changes a domain boundary:

- State whether this is documentation-only, API extraction, route move, persistence move, or renderer move.
- Keep moved files in a separate commit when practical so reviewers can separate rename noise from behavior changes.
- Include the backend Invariants section when backend behavior changes.
- Run `bun run check:patterns:diff`, targeted tests, and `bun run typecheck` before opening the PR.
- For React changes, run `npx react-doctor@latest <project-dir>`.
