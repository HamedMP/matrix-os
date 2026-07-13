# Implementation Plan: Attached Terminal Rich Paste

**Branch**: `106-terminal-rich-paste` | **Date**: 2026-07-08 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/106-terminal-rich-paste/spec.md`

## Summary

Attached CLI terminal sessions should treat paste input as a bounded rich paste transaction. The local CLI will detect image paths embedded inside pasted text, best-effort read image-only macOS clipboard data when a paste is observable, upload accepted images to the user's Matrix environment, rewrite the outgoing prompt to use remote Matrix paths, and only then forward input over the existing attached terminal session.

The design adds a small local paste preprocessor to the sync-client attach loop and a terminal-aware paste asset route in the gateway. The gateway owns remote path selection, validation, atomic writes, safe errors, and cleanup policy so local filenames and local filesystem paths never leak into remote prompts or durable owner state.

## Technical Context

**Language/Version**: TypeScript 5.9+, strict mode, ES modules; runtime target Node.js 24+  
**Primary Dependencies**: Existing sync-client CLI, gateway shell routes, Hono, Zod 4, native Fetch/FormData/Blob, existing `ws` attach transport  
**Storage**: Owner-controlled filesystem under Matrix home for paste assets; no new database persistence  
**Testing**: Vitest unit and gateway route tests, plus a manual attached-session quickstart  
**Target Platform**: macOS local CLI attached to a per-user Matrix VPS gateway; Linux gateway runtime  
**Project Type**: CLI plus gateway HTTP route  
**Performance Goals**: Rewrite successful paste transactions in under 3 seconds for accepted image sizes; provide local failure feedback within 2 seconds  
**Constraints**: Authenticated mutating route, bodyLimit before parsing, no local path leakage, no continuous clipboard monitoring, bounded asset count and size, symlink-safe cleanup  
**Scale/Scope**: One attached session paste transaction at a time per local CLI process; at least 5 image references per paste transaction

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Data Belongs to Its Owner**: PASS. Paste assets are written only into the authenticated user's Matrix home and are owner-visible/exportable/deletable. The route must not store platform-owned copies.
- **AI Is the Kernel**: PASS. The feature improves a shell input path and does not bypass or fork kernel behavior.
- **Headless Core, Multi-Shell**: PASS. The gateway route is shell-agnostic enough to remain a terminal capability, while this feature's UX is scoped to attached CLI sessions.
- **Defense in Depth**: PASS with design requirements. The new mutating route needs explicit auth, path-param validation, bodyLimit, image validation, size/count limits, atomic writes, generic client errors, server-side diagnostics, and cleanup.
- **TDD**: PASS with required next step. Implementation must start with failing sync-client and gateway tests before production code.
- **Worktree, PR, and Greptile 5/5**: CONDITIONAL PASS. Code implementation must happen in a manual git worktree and ship through a PR. This planning branch exists for Spec Kit bookkeeping; do not begin implementation until the working checkout satisfies the manual-worktree rule.
- **Documentation-Driven Development**: PASS with required task. Update public CLI/terminal docs in `www/content/docs/` during implementation.

No gate violations require a complexity exception.

## Project Structure

### Documentation (this feature)

```text
specs/106-terminal-rich-paste/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── cli-rich-paste.md
│   └── paste-assets.md
└── tasks.md
```

### Source Code (repository root)

```text
packages/sync-client/src/cli/
├── shell-client.ts              # attach loop integration point
├── rich-paste.ts                # new local paste transaction parser/rewriter
└── clipboard-image.ts           # new macOS clipboard image adapter

packages/sync-client/tests/unit/
├── rich-paste.test.ts           # new parser, rewrite, and failure tests
└── shell-client.test.ts         # attach loop integration tests

packages/gateway/src/shell/
├── routes.ts                    # terminal route registration
└── paste-assets.ts              # new paste asset validation/write/cleanup helper

tests/gateway/
└── shell-routes.test.ts         # route contract and security tests

www/content/docs/
└── ...                          # CLI terminal paste documentation update
```

**Structure Decision**: Keep local paste detection and clipboard access inside `packages/sync-client` because only the local CLI can read local files or the local clipboard. Keep remote path selection and asset writing inside `packages/gateway/src/shell` so the server enforces owner scoping, cleanup, validation, and safe error behavior for every client.

## Phase 0: Research

Resolved in [research.md](./research.md). Key decisions:

- Use a local rich paste transaction preprocessor before WebSocket input frames.
- Add a terminal-aware paste asset route instead of reusing generic file upload directly from the CLI.
- Use bounded multipart asset upload with gateway-selected remote filenames.
- Support pure image clipboard paste only when the paste action is observable.
- Implement paste asset retention as owner-visible temporary files with recurring, symlink-safe cleanup.

## Phase 1: Design & Contracts

Design artifacts:

- [data-model.md](./data-model.md)
- [contracts/cli-rich-paste.md](./contracts/cli-rich-paste.md)
- [contracts/paste-assets.md](./contracts/paste-assets.md)
- [quickstart.md](./quickstart.md)

### Auth Matrix

| Interface | Auth Method | Public? | Notes |
|-----------|-------------|---------|-------|
| `POST /api/terminal/sessions/:name/paste-assets` | Existing Matrix gateway bearer/session auth for terminal routes | No | Validates `:name`; writes only to authenticated user's Matrix home |
| Attached terminal WebSocket input | Existing terminal WebSocket auth | No | Receives rewritten prompt only after upload succeeds |
| Local clipboard/file reads | Local CLI process permissions | N/A | Reads only during a user paste transaction; no background monitoring |

### Input Validation & Resource Limits

- Validate terminal session names with the existing session-name schema.
- Apply bodyLimit before parsing the asset upload body.
- Accept only bounded image assets with allowed MIME/signature/extension combinations.
- Limit one paste transaction to 5 image assets and bounded total bytes.
- Generate remote filenames server-side; never persist original local paths.
- Use atomic file writes with exclusive temp files and rename.
- Use local and remote request timeouts so paste handling cannot hang indefinitely.
- Return generic client errors and log diagnostics server-side.
- Clean old paste assets with lstat-based symlink checks, max-age, max-count, and a recurring cleanup timer that is cleared on gateway shutdown.

## Post-Design Constitution Check

- **Data ownership** remains satisfied because assets are owner files under Matrix home.
- **Defense in Depth** remains satisfied because the route contract includes auth, validation, body limits, atomic writes, safe errors, and cleanup.
- **TDD** remains satisfied because quickstart and future tasks require failing tests first.
- **Worktree/PR gate** remains conditional until implementation begins in a manual worktree and PR workflow.

No complexity exceptions are needed.

## Complexity Tracking

No constitution violations or exceptional complexity are planned.
