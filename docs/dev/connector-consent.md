# Connector consent in Chat

Chat distinguishes active model work from waiting for an approval or response.
Pending requests appear above the work history. They must remain actionable in
both canonical Chat and the coding-agent conversation view.

## Protocol and consent

The Codex app-server adapter handles `mcpServer/elicitation/request` explicitly.
Supported forms include message-only consent, bounded primitive fields (text,
number, integer, boolean, enumerations and enumeration arrays), and URL-mode
authorization. Both `openai/form` spellings are accepted. Form answers are
converted back to their native types and validated before sending a response.

Consent is per request. Nothing is pre-approved and no persistent connector
grant is created. URL authorization opens only after a user clicks its HTTPS
link; opening the link does not itself submit consent. The user must confirm
after completing the external flow, or decline/cancel.

Product limits remain enforced: at most seven form fields plus consent, ten
options per field, four selected values, and 400 characters/700 UTF-8 bytes per
answer. Nested/custom schemas outside these supported shapes fail closed with
a protocol error; they do not leave an unanswered server request. Provider
metadata, defaults and persistent-grant suggestions are not automatically
applied. Response values are not copied into chat history or diagnostic logs.

## Ownership and lifecycle

`POST /api/chats/:chatId/runs/:runId/inputs/:requestId` uses the existing gateway
authentication and owner principal. It validates route identifiers and a
40-KiB bounded body. The orchestrator checks the exact active owner/chat/run
and persisted pending request before invoking the provider. The coding-thread
store validates correlation, question identities and options; the live runner
is authoritative for outstanding native requests and typed form constraints.

Pending requests are capped and expire after five minutes (swept every thirty
seconds). Expiry, turn termination and runner shutdown cancel rather than
approve. Resolution events clear the UI request. Unknown server requests
receive an explicit unsupported-method response instead of waiting forever.

## Verification

Focused tests cover the runner's real JSON-RPC/control-socket path, typed form
conversion, explicit consent, expiry, replay, owner isolation, body limits,
canonical input persistence/submission, and both conversation renderers.
Run the chat/coding-agent tests plus repository typecheck and pattern checks
before publication. Runtime and desktop/client delivery must both include the
change; updating a transport alone does not add missing request handling.
