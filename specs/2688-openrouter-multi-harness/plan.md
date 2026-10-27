# Implementation Plan: Shared OpenRouter Routing

**Branch**: `codex/eng-381-openrouter-routing` | **Date**: 2026-10-24 | **Spec**: [spec.md](./spec.md)

## Summary

Make the existing `owner_openrouter` source real through the established owner
key lifecycle, then project four explicit instances that launch with isolated,
child-only credentials. Exact route fingerprints and generation checks prevent
resume drift; a default-off operational flag and no-fallback rule contain risk.

## Technical context

- Node 24+, strict TypeScript, ESM, Zod 4, Hono, Vitest.
- Owner configuration files under `system/ai-providers/`; durable provider
  account configuration through the existing transaction boundary.
- Claude Agent SDK V1 `query()`/`resume`, Claude Code 2.1.240, Codex 0.162.1.
- Existing canonical provider V3 snapshot and key workflow; no new endpoint.

## Constitution check

| Principle | Response |
|---|---|
| Owner data | Secret remains in an owner-controlled 0600 file; owner can rotate/revoke it. |
| AI kernel | The kernel gains one explicit source; native paths remain intact. |
| Multi-shell | One gateway snapshot/actions surface feeds all renderers. |
| Defense in depth | Auth matrix, body limits, fixed URLs, timeout, redirect rejection, bounded state, atomic writes, safe errors, generation checks. |
| TDD | Each stack layer begins with failing contract/unit/integration tests. |
| Worktree/PR | Manual worktree, named stack, conventional commits, Greptile 5/5. |
| Public docs | Separate `FinnaAI/matrix-os-site` PR before public enablement. |

No exception is required.

## Architecture

```text
key workflow -> staged owner OpenRouter file -> provider transaction -> generation
      |                                      |
      +-> canonical account/access source ---+-> four provider instances
                                                     |
Chat selection -> exact execution fingerprint -> admission recheck -> isolated child
```

The file mutation and provider transaction use prepare/commit/rollback. Rotation
notifies the supervisor by generation mismatch; disconnect tombstones the file
before new admission and drains matching children.

## Stack

1. `spec-and-spikes`: this spec, exact compatibility matrix, sanitized evidence.
2. `canonical-connection`: OpenRouter key store, workflow, snapshot, UI reuse.
3. `matrix-paths`: Pi portable credential and Agent SDK endpoint/profile.
4. `coding-agents`: Claude Code and Codex isolated launch/admission.
5. `qualification-rollout`: full tests, flag, disposable VPS evidence, docs.

Each PR references ENG-381, this spec, and the stack. No layer enables production
by default.

## Wiring and shutdown

At gateway startup, resolve the OpenRouter store, verifier, provider service,
route resolver, and supervisor dependencies before route registration. The same
provider service supplies Settings and Chat. Catalog cache entries are capped
and TTL-evicted; timers clear at shutdown. Rotation/revoke signals the
supervisor, which cancels only children whose fingerprint contains the old
generation. Dependencies are drained before owned resources close.

## Rollout

Qualify an exact host bundle on a disposable VPS, then enable dev, canary, beta,
and stable sequentially. Rollback flips the capability flag: starts/resumes
fail closed while metadata, settings, and history remain readable.

