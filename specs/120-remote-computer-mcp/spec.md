# Feature Specification: Remote Computer MCP

**Feature Branch**: `codex/remote-computer-mcp`
**Created**: 2026-09-04
**Status**: Draft
**Input**: User description: "Ship an MCP and coding-agent plugin that can operate Matrix computers instead of the local computer: create and inspect persistent terminals and tabs, run commands, list computers, transfer files, and inspect chat sessions."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Run work on a chosen Matrix computer (Priority: P1)

A signed-in Matrix user enables the Matrix OS plugin in a coding agent, lists their available computers, chooses one explicitly, and runs a command there. The command returns bounded output and status to the agent so the agent can continue without using its local shell.

**Why this priority**: Remote execution is the central value of the feature. Computer discovery and explicit targeting prevent work from silently running on the wrong machine.

**Independent Test**: Connect the plugin to an account with two computers, list them, run a harmless command on the non-default computer, and verify the result identifies the selected computer and contains the remote command result.

**Acceptance Scenarios**:

1. **Given** a user is signed in and owns at least one available Matrix computer, **When** the agent lists computers, **Then** it receives only computers accessible to that user with stable identifiers, labels, availability, type, version, and capabilities.
2. **Given** two available computers, **When** the agent runs an argument-vector command against one stable identifier, **Then** the command executes only on that computer and returns exit status, standard output, standard error, duration, timeout status, and truncation status.
3. **Given** an unavailable, inaccessible, or unknown computer, **When** the agent targets it, **Then** no command runs and the agent receives a safe actionable error.
4. **Given** no valid Matrix sign-in, **When** any remote operation is attempted, **Then** it fails without exposing stored credentials and directs the user to authenticate with the Matrix CLI.

---

### User Story 2 - Work in persistent terminals and tabs (Priority: P1)

A coding agent can inspect persistent Matrix terminals, create a named terminal, inspect and create its tabs, select a tab, and send bounded input to the active terminal. These terminals remain visible and reconnectable in Matrix interfaces.

**Why this priority**: Persistent terminals make remote work observable to the user and let the user or another agent continue it later.

**Independent Test**: Create a new terminal on a selected computer, create a named tab, list both, select the tab, send a harmless command followed by Enter, and verify the terminal remains available through the existing Matrix terminal interface.

**Acceptance Scenarios**:

1. **Given** an available computer, **When** the agent lists terminals, **Then** it receives the user's current persistent terminal sessions without creating or changing any session.
2. **Given** an unused valid name, **When** the agent creates a terminal, **Then** exactly one persistent terminal is created and its normalized metadata is returned.
3. **Given** an existing terminal, **When** the agent lists or creates a tab, **Then** the operation applies only to that terminal and returns enough metadata to address the tab later.
4. **Given** an existing terminal and tab, **When** the agent selects the tab and sends bounded input, **Then** the input reaches that terminal and no local terminal is used.
5. **Given** a duplicate name, invalid name, oversized input, or stale terminal/tab reference, **When** the operation is attempted, **Then** the request is rejected without partial creation or disclosure of internal details.

---

### User Story 3 - Inspect and transfer Matrix files (Priority: P2)

A coding agent can list a directory, read bounded text, download bounded binary content through the tool result, and upload bounded content into the selected Matrix computer's home directory.

**Why this priority**: Agents need project context and artifact transfer, but file access must remain constrained to the owner's Matrix home and must not turn the MCP subprocess into a general local-filesystem bridge.

**Independent Test**: Upload a small text and binary fixture to a temporary Matrix-home path, list and read the text fixture, download both fixtures, verify byte equality, and verify that traversal, protected paths, oversize payloads, and accidental overwrites are rejected.

**Acceptance Scenarios**:

1. **Given** a valid Matrix-home directory, **When** the agent lists it, **Then** it receives a bounded set of file and directory metadata.
2. **Given** a regular UTF-8 file within the read limit, **When** the agent reads it, **Then** it receives the content and byte metadata without writing anything locally.
3. **Given** a regular file within the transfer limit, **When** the agent downloads it, **Then** its bytes are returned in a transport-safe representation with filename, media type, size, and truncation metadata.
4. **Given** bounded text or binary content and a valid Matrix-home destination, **When** the agent uploads it, **Then** the file is written atomically on the selected computer.
5. **Given** an existing destination, **When** upload is requested without explicit overwrite authorization, **Then** the existing file is unchanged.
6. **Given** an absolute path, traversal path, protected path, symlink escape, directory in place of a file, or oversized request, **When** a file operation is attempted, **Then** it is rejected safely.

---

### User Story 4 - Check Matrix chat sessions (Priority: P2)

A coding agent can list, search, and inspect the user's Matrix chat sessions on a selected computer without sending messages or changing chat state.

**Why this priority**: Existing chats contain task context that can help a coding agent continue work, while read-only access keeps the initial release narrow and predictable.

**Independent Test**: Seed multiple chats with messages, list and search them with pagination, inspect one chat, and verify no messages, lifecycle state, or unread state are modified.

**Acceptance Scenarios**:

1. **Given** a selected computer with chats, **When** the agent lists chats, **Then** it receives a bounded page of owner-authorized summaries and a continuation cursor when needed.
2. **Given** a bounded search query, **When** the agent searches chats, **Then** it receives only matching owner-authorized summaries.
3. **Given** an accessible chat identifier, **When** the agent inspects it, **Then** it receives bounded chat metadata and a paginated message page.
4. **Given** an inaccessible or unknown chat, **When** the agent inspects it, **Then** the operation returns a generic not-found response and leaks no cross-owner data.
5. **Given** any chat inspection operation, **When** it completes, **Then** no message is sent and no chat state is mutated.

---

### User Story 5 - Install one portable Matrix OS plugin (Priority: P3)

A coding-agent user installs or updates the existing Matrix OS plugin and receives both its guidance skills and its remote-computer MCP server. The MCP server uses the user's existing Matrix CLI profile and sign-in.

**Why this priority**: A single installable bundle makes the capability discoverable and avoids separate manual MCP configuration.

**Independent Test**: Validate the plugin bundle, install it in a clean coding-agent profile with an authenticated Matrix CLI, start a new conversation, and verify the Matrix tools are discoverable without placing credentials in plugin files.

**Acceptance Scenarios**:

1. **Given** the Matrix CLI is installed and authenticated, **When** the plugin is enabled, **Then** its MCP server starts through standard input/output and exposes the documented tools.
2. **Given** the plugin is installed but the CLI is unauthenticated, **When** a tool is invoked, **Then** the server returns safe setup guidance rather than prompting for or printing credentials.
3. **Given** the plugin is validated, **When** it is packaged, **Then** all referenced skills, assets, and MCP configuration are present and no secret or machine-specific path is embedded.

### Edge Cases

- The account has zero computers, more computers than one response can include, or a computer changes availability between discovery and execution.
- The selected computer changes, is reprovisioned, or its short-lived access token expires during a request.
- A terminal is created by another client between list and create, or a tab disappears before selection/input.
- Command output contains non-UTF-8 bytes, exceeds the response cap, times out, or the command exits due to a signal.
- A file is empty, binary, changes during download, has an unknown media type, or has a filename containing control characters.
- A chat has no messages, contains very large messages, is archived, or changes while pages are being read.
- The MCP client disconnects while an operation is in flight; the remote operation must retain the semantics of its underlying Matrix request and must not be retried invisibly.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST expose a local coding-agent MCP server through the existing Matrix OS plugin and Matrix CLI distribution.
- **FR-002**: The MCP server MUST authenticate from an explicitly selected or active Matrix CLI profile and MUST NOT accept, return, log, or persist credentials as tool arguments or results.
- **FR-003**: The system MUST list only computers authorized for the signed-in owner and MUST cap one response at 20 computers.
- **FR-004**: Every computer-scoped tool MUST require an explicit stable computer identifier; the server MUST NOT silently fall back to a different computer.
- **FR-005**: The system MUST resolve a fresh computer-scoped access token when the selected computer differs from the profile's current computer, without mutating the user's active profile.
- **FR-006**: The system MUST expose computer discovery, terminal listing/creation, tab listing/creation/selection, terminal input, captured command execution, directory listing, text-file reading, binary-safe download, binary-safe upload, chat listing/search, and chat detail tools.
- **FR-007**: Captured commands MUST be provided as an argument vector rather than an interpolated shell string, MUST support a validated Matrix-home-relative working directory, and MUST return structured completion metadata.
- **FR-008**: Captured command execution MUST default to a 10-minute timeout, MUST reject timeouts longer than 30 minutes, and MUST cap combined returned output at 1 MiB while reporting truncation.
- **FR-009**: Persistent terminal creation MUST accept a validated unique name and optional Matrix-home-relative working directory; a duplicate create MUST fail without altering the existing terminal.
- **FR-010**: Tab creation MUST target one named terminal, accept a bounded optional name and working directory, and return a stable tab index or identifier supplied by Matrix.
- **FR-011**: Terminal input MUST target one named terminal after explicit tab selection, MUST be capped at 60,000 bytes per request, and MUST be annotated as a state-changing operation.
- **FR-012**: The initial MCP release MUST NOT expose terminal/session/tab deletion, arbitrary pane manipulation, or an unbounded terminal-output stream.
- **FR-013**: All file paths MUST be normalized beneath the selected computer owner's Matrix home and MUST preserve existing protected-path, symlink, regular-file, and secret-file rules.
- **FR-014**: Directory listings MUST be capped at 500 entries, text reads MUST be capped at 256 KiB, and upload/download payloads MUST be capped at 1 MiB for MCP responses even if the underlying Matrix interface supports larger files.
- **FR-015**: File download MUST return bytes through the MCP result and MUST NOT write an arbitrary path on the coding agent's local computer.
- **FR-016**: File upload MUST accept either UTF-8 text or base64-encoded bytes, validate the claimed encoding, write atomically, and require an explicit overwrite flag before replacing an existing file.
- **FR-017**: Chat operations MUST be read-only, paginated, and bounded to at most 100 chats or messages per request.
- **FR-018**: All inputs MUST be validated at the MCP boundary before any network call, including identifiers, names, paths, limits, cursors, queries, command arguments, and encoded content.
- **FR-019**: Every remote network request MUST have an explicit timeout; the system MUST map auth, validation, not-found, conflict, size, timeout, and availability failures to a small allowlisted set of safe errors.
- **FR-020**: MCP responses MUST NOT reveal access tokens, cookies, provider errors, database errors, filesystem root paths, private hostnames, or raw internal error messages.
- **FR-021**: The plugin bundle MUST reference its MCP configuration in its manifest, use portable package-runner commands, and contain no environment-specific absolute paths.
- **FR-022**: The plugin's remote-work skills MUST prefer the MCP tools when available and MUST continue to document the CLI as a compatible fallback.
- **FR-023**: Integration tests MUST exercise the full MCP-tool-to-authenticated-Matrix-interface path for at least computer discovery, command execution, file transfer, terminal creation, and chat inspection.
- **FR-024**: The feature MUST document installation, authentication, computer targeting, tool behavior, limits, and the distinction between captured commands and persistent terminals.

### Authorization Matrix

| Operation group | Authentication source | Owner boundary | Public |
|---|---|---|---|
| Start local MCP server / discover tool schemas | Local plugin process | No owner data is read until a tool is called | Yes, locally |
| List computers | Active Matrix CLI sign-in | Signed-in user's runtime inventory only | No |
| Select computer / obtain scoped access | Active Matrix CLI sign-in | Requested computer must belong to the signed-in user | No |
| Commands and persistent terminals | Computer-scoped Matrix access | Selected computer and its owner only | No |
| Files | Computer-scoped Matrix access plus Matrix-home path policy | Selected owner's Matrix home only | No |
| Chats | Computer-scoped Matrix access plus chat ownership checks | Selected owner's chats only | No |

### Key Entities

- **Computer Reference**: A stable runtime identifier plus user-facing label, handle, availability, type, version, gateway location, and declared capabilities. It belongs to exactly one signed-in owner.
- **Runtime Access**: A short-lived, computer-scoped authorization resolved from the active Matrix sign-in. It is never returned to the MCP client.
- **Terminal Session**: A persistent, user-visible terminal identified by a validated name on one computer. It owns an ordered collection of tabs.
- **Terminal Tab**: A user-visible execution surface within one terminal session, addressable by the index or identifier supplied by Matrix.
- **Captured Command Result**: A bounded, non-persistent execution result containing output, exit, signal, timeout, truncation, duration, and selected-computer metadata.
- **Remote File Payload**: Bounded text or binary content associated with a normalized Matrix-home-relative path, size, filename, and media type.
- **Chat Summary and Detail**: Read-only, owner-authorized chat metadata and paginated messages with stable cursors.

### Assumptions

- A "process" in this feature means an operating-system program that is currently running. Matrix does not introduce a second persistent process registry: long-lived observable work is represented by terminal sessions and tabs, while one-shot work is represented by captured command results.
- The MCP transport is local standard input/output for the first release. A hosted HTTP MCP endpoint and its OAuth lifecycle are deferred.
- The existing Matrix CLI device login, computer inventory, terminal, file, and chat interfaces remain the source of truth; this feature adds a bounded adapter rather than duplicating those domains.
- File transfer through MCP is intentionally smaller than interactive CLI transfer. Larger files continue to use the existing `matrix upload` and `matrix download` commands.
- Chat mutation, terminal deletion, live terminal streaming, background job scheduling, plugin marketplace publication, and automatic disabling of a coding agent's built-in local shell are outside this release.
- To enforce a fully remote workflow, users or agent hosts must separately disable local shell tools and enable the Matrix MCP tools.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A signed-in user can discover a computer and complete a captured remote command through an MCP client in under 30 seconds, excluding the command's own runtime.
- **SC-002**: In automated tests with two user-owned computers, 100% of tool calls execute against the explicitly named computer and 0% silently fall back to another runtime.
- **SC-003**: Terminal, file, and chat tool responses stay within their documented caps for boundary-size and oversize test cases, with truncation or rejection reported explicitly.
- **SC-004**: Traversal, protected-path, cross-owner computer, cross-owner chat, expired-auth, invalid-base64, oversized-input, and accidental-overwrite tests all fail without remote mutation or sensitive-data disclosure.
- **SC-005**: A clean plugin validation run reports no manifest, referenced-file, placeholder, or portability errors.
- **SC-006**: The full feature test suite, type check, repository pattern check, and existing regression suite pass before the pull request is opened.
- **SC-007**: A new coding-agent conversation can discover all documented Matrix tools after one plugin installation and an existing Matrix CLI sign-in, without manual credential configuration.
