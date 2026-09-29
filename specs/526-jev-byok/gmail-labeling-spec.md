# Gmail labeling milestone (ENG-42)

The product goal is a bot that actually labels the owner's connected Gmail. This milestone supersedes the earlier read-only release acceptance in `spec.md`, while preserving the isolated Hermes execution and Matrix-funded Jev route from ENG-40 / PR #2035.

## User experience and authorization

- Recipe creation and editing offer an unchecked, explicit **Allow this bot to add Jev labels to the selected Gmail account** setting. Saving it grants this bot permission to add only the fixed category labels during its runs. Creation alone performs no mailbox operation.
- Existing bots remain preview-only until the owner enables this setting. Disabling it or changing the account/revision revokes active-run authority. Instructions are never authorization.
- With permission enabled, the existing discover → select → evaluate flow classifies a selected thread's latest four messages and adds its verified labels automatically. No second prompt or personal Jev key is needed. Preview-only bots return proposals.
- Add labels only to the exact messages classified, never unseen older messages. Leave every existing label (including INBOX/UNREAD) intact. Archive, delete, send, mark-read, arbitrary labels and file access remain outside this milestone.

## Backend and transport

The authenticated Agent API stores the opt-in and derives the owner/account binding. The isolated broker reads the saved revision/grant, derives evidence and policy server-side, rechecks live identity and thread evidence immediately before writing, and invokes a narrow bound Gmail labeling client. No model-supplied scores, labels, message IDs, URLs or confirmation flags authorize a write.

| Route | Authentication | Scope / public |
| --- | --- | --- |
| Existing Agent create/patch | Authenticated owner | Saves explicit opt-in; not public |
| Existing `/api/jev/inbox/preview` | Active restricted run capability and owner principal | Historical path retained; evaluate may label only with saved grant; not public |
| Internal `/integrations/jev-label-call` | Existing Platform principal / verified machine delegation | Exact owner, active Gmail binding, fixed category labels and 1–4 IDs; rejects read-only run scope; not public |

The Gmail transport permits only label inventory, message label readback, fixed-name label creation and message modify with **addLabelIds only**. All URLs/methods are constructed internally; redirects are rejected. OAuth resolution, response streaming and external calls have deadlines and byte caps. Live Gmail identity is checked before each mutation. Gmail calls are not transactional: completed label creations or partial message updates may remain after failure. Report **unconfirmed** rather than claiming no changes or success; retain the run's failed attempt and never blindly replay it. A later explicit run reads existing labels first; additive updates are idempotent.

Successful results require independent Gmail message readback showing every expected label ID on each targeted message. The broker owns the user-visible receipt and persisted Chat tool output. Do not trust Hermes's success claim. Unknown/partial results instruct users to check Gmail. Unverified Review results produce no writes. Empty verified label sets are a successful no-op.

Verified scores that require Review also produce no writes, with an explicit `review_required` reason. A read-only result is not proof that the saved grant is disabled; `preview_only` is reported separately. The bot must not ask users to enable an already-enabled permission.

Authorization is rechecked before dispatch and between broker stages. Revocation/cancellation prevents subsequent dispatches but cannot recall a Gmail mutation already in flight. The same distributed race applies if mail arrives after the last snapshot check: writes stay limited to the server's originally classified message IDs. These are additive operations; no thread-wide mutation is used.

Existing integration registration exceeds the preferred file size. New behavior is extracted into `jev-label-call.ts`, `jev-bound-labels.ts` and `pipedream-bounded-labels.ts`; the existing registry receives one composition line only. A later registry cleanup should extract route assembly without combining provider behavior into that large file.

## Verification and delivery

Use the agreed product boundaries: authenticated recipe grant/binding, broker execution through the Gmail external seam, and Electron Desktop → local Linux → configured Hermes → Jev → actual Gmail readback. TDD covers disabled grants, foreign/rebound/revoked accounts, changed evidence, concurrent/repeated evaluation, add-only semantics, malformed/readback failures and unknown mutations. Preserve existing preview tests. Shared recipe components provide the same behavior across their Web and Electron renderers; no renderer-specific authorization logic.

Create a separate feature PR stacked on #2035 and attach important UI/readback evidence to ENG-42. Keep production acceptance separate from local fixture validation. Public documentation is a separate `FinnaAI/matrix-os-site` PR after acceptance, deferred from this repository's implementation per the user's tracker policy.

Gmail API contracts: [create labels](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.labels/create), [add message labels](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/modify).
