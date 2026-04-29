# Legacy Principal Callers

This tracker keeps migration scope explicit while `getUserIdFromContext` remains as a compatibility wrapper.

## Canonical Target

- `packages/gateway/src/request-principal.ts` owns canonical request principal resolution.
- New or touched protected routes must use `requireRequestPrincipal`, `getOptionalRequestPrincipal`, or an injected dependency that delegates to the canonical accessor.

## Known Legacy Compatibility Callers

| File | Caller | Status | Removal Criteria |
|------|--------|--------|------------------|
| `packages/gateway/src/auth.ts` | `getUserIdFromContext` | Compatibility wrapper | Remove after all protected routes and sync tests consume canonical principal helpers directly. |

## Guardrail

`scripts/review/check-patterns.sh` fails when `getUserIdFromContext()` is called outside `packages/gateway/src/auth.ts`. New or touched protected routes should use `requireRequestPrincipal`, `getOptionalRequestPrincipal`, or an injected owner-scope/principal dependency that delegates to those helpers.

## Migration Rule

Do not add direct fallback resolution from JWT/env/default identity in protected route handlers. Route handlers should consume a request principal accessor or an injected principal-derived owner scope.
