# Gmail connection-method labels

Ticket: [ENG-355](https://linear.app/matrix-os/issue/ENG-355/prepare-gmail-oauth-verification-and-casa-evidence).
Stack: [Gmail provider choice completion](https://github.com/HamedMP/matrix-os/pull/2928).

## Problem and requirements

An owner can connect the same Gmail address through Matrix and Pipedream. Editable account names and connection dates do not identify the connection method. Every connected Gmail row must show a persistent **Matrix** or **Pipedream** badge, including single-account and rename states. Unknown metadata on older client/server pairs must show **Method unavailable** rather than guess. Shared Web Canvas, Web Desktop, Web Mobile, Electron Desktop and Native Mobile use the same vocabulary. Narrow rows must wrap controls without hiding the method.

## Source of truth and API boundary

The server derives optional `connection_method` (`matrix` or `pipedream`) from the persisted transport identity. Client names, email addresses, row order and caller flags cannot choose it. Existing owner-authenticated list, explicit sync and status routes must agree; no new route or authorization path is introduced. List and sync share a display-safe projection so provider account IDs, token fields and database-only attributes never become display metadata. Other integration types keep their existing display behavior.

## Verification

Use identical emails and account labels, labels deliberately naming the opposite transport, single/edit states, missing/invalid method metadata, and unauthorized/foreign-owner reads. Verify both the canonical list and explicit sync, plus shared client parsing and each renderer. Run regression suites and strict type checks remotely. Capture the deployed exact candidate on each applicable surface; Native Mobile live evidence remains explicitly deferred by the owner.

Update the Gmail help in [website PR #287](https://github.com/FinnaAI/matrix-os-site/pull/287) to explain the badges. These labels do not qualify mailbox execution, AI processing or provider compliance.
