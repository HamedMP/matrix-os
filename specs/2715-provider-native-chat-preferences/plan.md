# Provider-native Chat controls and defaults

Ticket: [ENG-404](https://linear.app/matrix-os/issue/ENG-404/preserve-chat-effort-and-permission-when-switching-providers).

## Behavior

The existing Chat permission drawer shows Codex Ask for approval, Approve for me,
and Full access. Claude shows Manual, Accept edits, Auto, Don’t ask, and Full access.
Plan/review remains the existing separate interaction control. Reasoning retains
provider-specific values, including Claude extra high. Each provider instance keeps
its own model, effort and permission defaults. Explicit model selections win over
remembered models; switching providers restores only destination preferences.
First use retains existing defaults. Existing account bindings, provider locks and
unavailable selections must remain authoritative.

## Implementation

Reuse Desktop providerPreferences storage and its owner/computer boundary. Retain
Web’s existing preference configuration storage with a bounded per-instance map
and migration from its single saved selection. Do not change existing Chat history
or active runs when a default changes.

Codex automatic review is a distinct internal approval policy, converted at the
native boundary to on-request plus approvalsReviewer=auto_review. Human mode must
explicitly select user. Carry policies on new, resumed, recovered and same-process
turns; use native sandboxPolicy on turn/start. Extract native permission parameter
construction from the large runner into one focused helper before adding behavior.
Reject provider-incompatible modes. Legacy saved Codex Auto/Accept edits choices
fall back to supervised; they must not silently acquire automatic review.

Protocol spike: installed Codex 0.162.1 experimental JSON schemas confirm
approvalsReviewer on thread/start, thread/resume and turn/start, with user and
auto_review. Generated schemas live outside the repo under /tmp and are removable.

## Design

Keep existing shared composer menus, typography, spacing, theme tokens and focus
behavior. Use the selected provider’s native names. No new animation or layout.

## Acceptance and validation

- Desktop and Web: set different effort/access per provider, A → B → A, choose an
  explicit model, start a new chat, reload and inspect restored preferences.
- Catalog/launch/control boundaries: each choice produces distinct native fields;
  automatic review retains workspace sandbox; human mode explicitly selects user.
- Regression red/green precedes implementation. Run focused suites and typechecks.
- Capture affected live Desktop and Web menus, provider switching and reload.
  Mobile consumes the catalog and labels: validate it separately if changed.
  Fixtures and unit tests are not live provider or visual qualification.
- Recommend affected engineering/product owners review permission semantics.
- Public documentation follow-up: separate PR in FinnaAI/matrix-os-site content/docs
  for provider-specific permissions and remembered defaults; do not recreate site here.
- Keep screenshots/recordings outside repo; attach to PR and authorized #tech post.

## Invariants

Preference changes grant no authority to an active run. Admission validates the
selected provider catalog and account; the native provider enforces managed policy.
No new database writes, credentials or network endpoints. Defaults remain scoped
per instance. No orphan resources created. No deployment or merge in this task.
