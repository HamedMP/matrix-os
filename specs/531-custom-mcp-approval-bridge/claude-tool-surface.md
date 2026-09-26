# Claude Custom MCP tool advertisement

Canonical Claude Chat uses an actor-bound run grant for personal Custom MCP. Its MCP initialization instructions and tool inventory must describe that grant's runnable surface. Advertising ordinary integration inventory encouraged the model to request a native permission that this route cannot approve; its HTTP endpoint is also outside this grant.

The adapter projects the exact successfully issued scope into MCP launcher arguments. `custom-mcp-call` exposes only `list_custom_mcp_servers`, `describe_custom_mcp_server`, and `call_custom_mcp_tool`, and recommends that sequence. `custom-mcp-discovery` exposes only list and describe. The default `full` surface preserves existing clients' tools and instructions. Unknown or duplicate selectors fail closed.

The selector controls advertisement, not authorization. Gateway's owner/run capability registry remains authoritative for method and path checks, including when a client explicitly selects `full`. Tool annotations do not grant authority. Neither the selector nor its projection is persisted in owner configuration. Existing native permissions, sandbox enforcement, approval receipts, and capability lifecycle are preserved.

Claude's saved-recipe prompt defers generic ordinary-integration recommendations until actual grant issuance. The adapter describes only the issued Custom MCP route, or explicitly states that no Matrix tools are available when issuance fails. The recipe's selected ordinary integration dependencies remain unavailable on this route; they are not remapped to arbitrary Custom MCP tools. Other clients retain existing recipe guidance. Saved Agent admission constraints are unchanged. The large orchestrator receives only a context-composition parameter at its existing wiring seam; a later focused refactor should extract that composition boundary before adding business logic there.

## Verification

- Immutable protocol regression: `58903e635dbb84c51882882721aa06b2ff625dae`, three expected failures and two full-client controls on the pre-fix source.
- Actual stdio initialization and tools/list verify call, discovery, full/default, and invalid selectors; discovery cannot call an unregistered tool.
- Fresh and resumed canonical launch fixtures verify argv projection, including review with a saved full-access choice.
- The installed Bash wrapper forwards selectors after environment isolation and rejects invalid/duplicate arguments before credential lookup.
- Loopback stdio → actual scoped Gateway authentication verifies full advertisement cannot authorize ordinary inventory or a remote call under discovery, and revoked tokens remain denied.
- Actual native stdin prompt fixtures verify issued call/discovery guidance and denial when owner-bound issuance fails; full recipe context remains unchanged.

No model spend or real integration calls are required for these checks. Live provider behavior on the affected runtime remains a separate acceptance gate.
