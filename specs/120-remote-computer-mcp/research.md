# Research: Remote Computer MCP

## Decision 1: Treat terminals, not processes, as the persistent object

**Decision**: Model persistent observable work as Matrix zellij terminal sessions and tabs. Keep `run_command` as a one-shot captured operating-system process without a new process registry.

**Rationale**: Matrix already persists and renders sessions/tabs across its clients. A second process abstraction would duplicate lifecycle state while still needing a terminal for observation.

**Alternatives considered**:

- Add detached process/job records: rejected because it adds persistence, cleanup, and UI parity work before a user need exists.
- Treat every command as a terminal: rejected because agents need structured output and exit status for small probes.

## Decision 2: Ship a local stdio bridge first

**Decision**: Add `matrix mcp serve` to the published CLI and start it from the existing plugin using stdio.

**Rationale**: The CLI already owns device login, profile selection, and a portable runtime. Stdio keeps credentials local, requires no new public endpoint, and works with coding agents that support local MCP subprocesses.

**Alternatives considered**:

- Hosted Streamable HTTP MCP: deferred because it requires a protected-resource metadata and OAuth 2.1 lifecycle, audience validation, and additional deployment/abuse controls.
- A new private workspace package: rejected because a coding agent outside the Matrix monorepo could not install it.
- Embed a JavaScript server inside the plugin: rejected because it would duplicate the authenticated CLI client and release channel.

**Primary references**:

- MCP authorization requirements: https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization
- MCP 2026-07-28 stateless transport update: https://blog.modelcontextprotocol.io/posts/2026-07-28/

## Decision 3: Require explicit computer targeting

**Decision**: Require the runtime slot on every computer-scoped tool. Refresh inventory for resolution and mint a non-persisted scoped token when the requested slot differs from the profile token.

**Rationale**: Agents must never silently run on another machine. Runtime slots are validated, owner-scoped, stable identifiers; labels and handles are display metadata.

**Alternatives considered**:

- Implicit current computer: rejected because multi-computer workflows become ambiguous.
- Persist every tool-selected computer to the CLI profile: rejected because an agent call should not alter the user's global CLI state.
- Accept raw gateway URLs: rejected because it would bypass inventory ownership and create an SSRF boundary.

## Decision 4: Use existing interfaces without adding gateway endpoints

**Decision**: Delegate to existing computer inventory/runtime selection, terminal, captured command, file list/blob, and canonical chat routes.

**Rationale**: These routes already implement owner auth, home-path security, zellij lifecycle, output caps, atomic upload, and canonical chat ownership. The MCP boundary adds stricter limits where protocol responses need to stay smaller.

**Alternatives considered**:

- A broad `/api/mcp/*` proxy: rejected because it would duplicate authorization and parsing.
- Direct SSH: rejected because it bypasses Matrix identity, routing, auditability, and customer topology.

## Decision 5: Keep MCP file transfer content-based and small

**Decision**: Return downloads as bounded base64 with metadata and accept uploads as either bounded UTF-8 text or validated base64. Never accept a local source/destination path.

**Rationale**: A local-path file bridge lets prompt-injected content read or overwrite the coding-agent host. Content-based transfer preserves the remote-computer boundary and remains portable across MCP clients.

**Alternatives considered**:

- Arbitrary local path arguments: rejected as an unnecessary local filesystem capability.
- Large binary streaming: deferred until MCP client support and resumable semantics are designed.
- Signed download URLs: rejected because current file routes require bearer auth and tokens must not appear in URLs.

## Decision 6: Keep chats read-only

**Decision**: Expose list, search, and detail only, with at most 100 list items/messages per request.

**Rationale**: The stated need is to check chat sessions. Mutations need separate approval semantics, idempotency, queue state, and notification expectations.

**Alternatives considered**:

- Expose the whole canonical chat API: rejected as oversized and riskier than the request.
- Read raw conversation files: rejected because canonical chats live in owner-controlled Postgres and gateway contracts are the source of truth.

## Decision 7: Extend the existing Matrix OS plugin

**Decision**: Add `.mcp.json` and `mcpServers` to `plugins/matrix-os`, bump its version, and update its skills to prefer MCP while retaining CLI fallback instructions.

**Rationale**: Users should install one Matrix OS bundle, not choose between a skills plugin and a remote-tools plugin. The repo-local marketplace already contains the plugin and its policy metadata.

**Alternatives considered**:

- Create a second `matrix-remote` plugin: rejected because it splits discovery and duplicates onboarding.
- Replace the skills with MCP only: rejected because safe workflow guidance remains valuable and supports clients where the MCP server is unavailable.

## Decision 8: Use the stable MCP SDK server API already verified in the repository

**Decision**: Use `McpServer.registerTool` and `StdioServerTransport`, already exercised by `packages/integrations-mcp` with SDK 1.29.

**Rationale**: This is not an undocumented SDK assumption; the repository already builds and tests the same boundary. Tool annotations describe read-only, destructive, and open-world characteristics.

**Alternatives considered**:

- Implement JSON-RPC manually: rejected because protocol framing and schema interoperability are existing SDK responsibilities.
- Use the Agent SDK's in-process MCP helper: rejected because the server must work across coding-agent hosts, not only Matrix's current kernel.
