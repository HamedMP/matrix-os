# Research: Remote Computer MCP

## Decisions

### Persistent work is a terminal, not a process registry

Matrix zellij sessions and tabs are the persistent, observable objects. `run_command` remains a one-shot OS process with captured output and exit metadata. A detached-job registry would duplicate terminal lifecycle, cleanup, and UI state.

### Ship a local stdio bridge

The published CLI exposes `matrix mcp serve`; the Matrix plugin starts it over stdio. The CLI already owns portable profile auth, and stdio keeps credentials local. Hosted HTTP MCP is deferred until its OAuth 2.1, protected-resource metadata, audience, deployment, and abuse-control design exists. References: [MCP authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization) and [stateless transport update](https://blog.modelcontextprotocol.io/posts/2026-07-28/).

### Every operation names a computer

Computer-scoped tools require the inventory `runtimeSlot`. Inventory is refreshed and a non-persisted scoped token is minted when the slot differs from the profile token. This prevents accidental execution elsewhere without mutating the user's global CLI selection. Raw gateway URLs are never accepted.

### Reuse Matrix interfaces; extend stable tab selection only

The bridge delegates to existing inventory/runtime selection, terminal, command, file, and canonical chat routes. Zellij 0.44.3 emits a stable ID from `new-tab` and supports `go-to-tab-by-id`, so one authenticated, bounded route selects by ID while existing position-based clients remain compatible. A generic MCP proxy or direct SSH would duplicate or bypass Matrix authorization.

### Transfer bounded content, never local paths

Downloads return metadata plus at most 1 MiB of base64; uploads accept bounded UTF-8 or validated base64. Text reads are capped at 256 KiB. Local source/destination paths are forbidden because they would expose the coding-agent host. Large streaming and resumable transfer remain deferred.

### Chats are read-only

List, search, and detail use canonical owner-scoped chat routes with pages of at most 100 items/messages. Mutations need separate approval, idempotency, delivery, and notification semantics.

### Extend the existing plugin and verified SDK path

`plugins/matrix-os` gains `.mcp.json` and retains workflow skills as guidance/fallback. The CLI uses the repository-verified MCP SDK `McpServer.registerTool` plus `StdioServerTransport`; handwritten JSON-RPC and an Agent-SDK-only server would reduce portability.
