# Implementation Plan: Remote Computer MCP

**Branch**: `codex/remote-computer-mcp` | **Date**: 2026-09-04 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/120-remote-computer-mcp/spec.md`

## Summary

Extend the published Matrix CLI with a local stdio MCP server and attach it to the existing Matrix OS coding-agent plugin. Each tool validates input locally, resolves the requested owner-authorized computer without changing the active CLI profile, then delegates to the existing authenticated platform/gateway interfaces for terminals, commands, files, and chats. No new persistence or remote HTTP MCP endpoint is introduced.

The implementation deliberately distinguishes two execution modes:

- `run_command` is a bounded, captured, one-shot remote process using an argv array.
- persistent observable work uses a named zellij terminal and tabs through create/list/select/input tools.

## Technical Context

**Language/Version**: TypeScript 5.9 strict, ES modules; Node.js 24 production target (published CLI remains compatible with Node.js 20+)
**Primary Dependencies**: `@modelcontextprotocol/sdk` 1.29, Zod 4, citty, native Fetch/AbortSignal, existing Matrix CLI shell/file/profile clients
**Storage**: No new storage; reads existing owner-scoped Matrix CLI profile/auth files and Matrix computer data
**Testing**: Vitest unit, contract, and mocked full-path integration tests; plugin validator; repository type/pattern/full test gates
**Target Platform**: Local coding-agent host starting a stdio child process; remote Matrix customer VPS data plane
**Project Type**: Monorepo package extension plus existing repository-local Codex plugin
**Performance Goals**: tool discovery under 2 seconds after process start; non-command API calls complete within 10 seconds under normal conditions; bounded command/file calls use documented longer timeouts
**Constraints**: explicit computer on every scoped call; no local arbitrary file reads/writes; 20 computers; 500 directory entries; 256 KiB text; 1 MiB MCP binary transfer; 1 MiB command output; 30-minute maximum command timeout; 60,000-byte terminal input
**Scale/Scope**: 15 MCP tools across five domains; one active CLI profile per MCP process; at most 20 owner-authorized computers per inventory

## Constitution Check

*GATE: Passed before research and re-checked after design.*

| Principle | Design evidence | Status |
|---|---|---|
| Data belongs to its owner | Computer inventory and runtime access derive from the signed-in owner; files stay in the selected Matrix home; chats use canonical owner checks; no data is copied into new storage. | Pass |
| AI is the kernel | The feature exposes Matrix's existing headless capabilities to coding agents without adding a parallel orchestration store or provider-specific kernel. | Pass |
| Headless core, multi-shell | MCP is another programmatic shell over the same gateway contracts used by CLI and visual clients. | Pass |
| Defense in depth | Every tool has strict boundary schemas, explicit computer targeting, bounded responses, request timeouts, allowlisted errors, and no credential/result leakage. The auth matrix is in the specification. | Pass |
| TDD | Tests for schemas, routing, safe errors, each domain client, tool registration, and full-path calls are written failing before implementation. | Pass |
| Worktree and PR | Work occurs in a manual worktree on `codex/remote-computer-mcp`; changes ship through a Conventional Commit PR with required invariants and Greptile gate. | Pass |
| Documentation-driven development | This repository includes operator/developer quickstart updates; a separate `FinnaAI/matrix-os-site` documentation PR is an explicit release deliverable. | Pass, release deliverable |
| No unjustified persistence/dependencies | No database or alternate persistence is added. MCP SDK is required for the protocol boundary; native Fetch handles network calls. | Pass |

### Post-design re-check

The contracts retain explicit runtime identity, preserve the gateway as the authorization source of truth, and add no server endpoints. State-changing tools reuse existing endpoint validation and atomicity. No constitution exception is required.

## Architecture

```text
Coding agent
  -> Matrix OS plugin (.mcp.json)
    -> matrix mcp serve (local stdio; active CLI profile)
      -> computer inventory / scoped-token resolver (platform)
        -> selected Matrix gateway
          -> terminal + command + file + canonical chat interfaces
```

### Runtime wiring

1. The plugin starts `matrix mcp serve`; the server writes protocol messages only to stdout and diagnostics only to stderr.
2. The first tool call loads the selected CLI profile and validates its unexpired auth record.
3. `list_computers` calls the platform inventory with the profile token.
4. Every scoped tool resolves its required `computer` runtime slot from a fresh bounded inventory.
5. If the slot differs from the token's current slot, the resolver requests a short-lived replacement token from the platform control-plane origin. The token remains process-private and is not persisted.
6. The resolver combines the trusted profile origin and inventory-provided gateway path, then the domain client appends only fixed API paths while preserving the runtime query.
7. Domain responses are parsed, projected into bounded MCP-safe results, and returned as text JSON or binary-safe base64 metadata.

### Error and retry policy

- Validation fails before network activity.
- Fetch failures map to `auth_required`, `computer_not_found`, `computer_unavailable`, `not_found`, `conflict`, `payload_too_large`, `request_timeout`, or `request_failed`.
- No tool retries a mutating call. Inventory may be refreshed once before a scoped call, but a failed domain request is never invisibly replayed.
- Raw response bodies, URLs, paths outside Matrix home, and internal exception messages never reach tool output.

## Project Structure

### Documentation (this feature)

```text
specs/120-remote-computer-mcp/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── tools.md
└── tasks.md
```

### Source Code (repository root)

```text
packages/sync-client/
├── package.json
├── src/
│   ├── cli/
│   │   ├── commands/mcp.ts
│   │   └── index.ts
│   └── mcp/
│       ├── clients.ts
│       ├── errors.ts
│       ├── profile-context.ts
│       ├── schemas.ts
│       └── server.ts
└── tests/
    ├── integration/mcp-server.test.ts
    └── unit/
        ├── mcp-clients.test.ts
        ├── mcp-profile-context.test.ts
        └── mcp-schemas.test.ts

plugins/matrix-os/
├── .codex-plugin/plugin.json
├── .mcp.json
└── skills/
    ├── matrix-cloud-run/SKILL.md
    └── matrix-github-project/SKILL.md

tests/plugins/
└── matrix-os-plugin.test.ts
```

**Structure Decision**: Keep the protocol adapter in the already published and authenticated `@finnaai/matrix` CLI, organized by responsibility to keep files below the project's large-file threshold. Extend the existing `matrix-os` plugin rather than creating a second marketplace item. Reuse gateway routes unchanged.

## Delivery Strategy

One implementation PR is appropriate because the source change is isolated to the CLI package and existing plugin, adds no gateway endpoints or migrations, and can remain below 20 production/test files. The PR is independently releasable after publishing the next CLI patch version. A separate public documentation PR in `FinnaAI/matrix-os-site` is required before release.

### Required PR invariants

- **Source of truth**: active CLI profile/auth for principal identity; platform computer inventory for available runtimes; selected gateway for terminals/files/chats.
- **Lock/transaction scope**: none added; one-shot operations delegate to existing atomic gateway behavior.
- **Acceptable orphan states**: a newly created terminal or tab may remain if the MCP client disconnects after the gateway commits; this is visible owner data and can be managed through Matrix.
- **Auth source of truth**: platform-issued sync bearer plus selected computer-scoped replacement token.
- **Deferred scope**: hosted Streamable HTTP/OAuth MCP, chat mutations, delete tools, pane tools, live terminal streaming, large-file MCP streaming, disabling host local-shell tools, and public marketplace publication.

## Complexity Tracking

No constitution violations require justification.
