# Data Model: Remote Computer MCP

No entity is persisted. These are validated, per-call projections.

## CLI principal and runtime

- **CLI principal**: profile name; trusted platform/gateway origins; process-private owner token and expiry; authenticated user, handle, and runtime slot.
- **Computer reference**: safe handle; stable `runtimeSlot`; label, availability, kind, version, capabilities; inventory-derived `gatewayPath` that must match handle and slot.
- **Scoped runtime**: one computer, validated gateway base, and current or freshly minted non-persisted token.

Missing/expired auth becomes `auth_required`. Tokens never enter tool inputs, outputs, logs, or MCP persistence. Every scoped call targets exactly one inventory member; unknown/unavailable targets fail safely. No token cache or unbounded in-memory collection is added.

```text
unknown -> inventory member -> available -> scoped call
                         \-> unavailable -> safe rejection
```

## Terminal session and tab

A terminal belongs to one computer and owns zero or more tabs. Session responses keep bounded names and known status/metadata while discarding unknown fields. A tab exposes stable numeric `id`, current display position `idx`, optional name, and focus state.

```text
session: absent --create--> active --list/input--> active
tab:     absent --create--> present --select by id--> focused
```

Deletion is outside scope. Input targets the selected tab.

## Captured command

Input: computer slot, 1-64 argv items (1-4096 characters each), optional Matrix-home-relative `cwd`, and 1 second-to-30 minute timeout. Result: selected computer, bounded stdout/stderr, exit code, signal, timeout/truncation flags, and duration. Its lifetime is one request.

## Remote file payload

Fields: computer, normalized Matrix-home-relative path, filename, media type, size, `utf8|base64` encoding/content, and explicit overwrite/secret flags. Absolute/traversal paths are invalid; text is capped at 256 KiB and binary transfer at 1 MiB. Existing files require `overwrite=true`. Downloads never accept a local destination.

## Chat page

Inputs: computer, limit 1-100, optional bounded cursor/lifecycle/project/query, and canonical chat ID for detail. Results contain projected canonical records, at most 100 messages, and an optional cursor. Chats are read-only; unknown and cross-owner IDs both map to `not_found`.
