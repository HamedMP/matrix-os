---
status: implemented
linear: https://linear.app/matrix-os/issue/ENG-408/fixdesktop-open-chat-agent-recipes-from-embedded-apps
---

# Native Chat recipe navigation

Electron embedded apps need a narrow, acknowledged route into native Chat's
Recipes view. Expose `MatrixOS.openChat({ view: "recipes", recipeId? })` without
relaxing the installed-app `openApp` path allowlist. Main authenticates the app
document, validates a bounded kebab-case catalog ID, focuses Desktop Chat, and
waits for the renderer to acknowledge either the recipe list or an exact live
catalog match. Unknown IDs remain visible in Chat and reject back to the app.

Navigation owns no persistence. The recipe setup form can create a bot only
after the user explicitly submits its existing creation action. Bound the main
broker to one pending request and a 15-second timeout, invalidate it on auth,
runtime, window, or app lifecycle changes, and reject all internal failures with
a generic app-facing error. Preserve the current runtime slot and authentication
generation across the main-to-renderer event.

Test-first coverage must exercise preload validation, authenticated IPC,
closed/open/minimized Chat restoration, the full list, Company Brain and another
live recipe, unknown IDs, and absence of recipe instantiation during navigation.
Alice's separate app source must switch its section action to `{ view: "recipes" }`
and card actions to `{ view: "recipes", recipeId: <live catalog id> }`, restoring
the `Set up bot` label after a Desktop build containing this API is available.

Public documentation is a separate required deliverable: open a PR in
`FinnaAI/matrix-os-site` under `content/docs/` that documents the embedded-app
`openChat` contract, supported Recipes payload, acknowledgement failures, and
the no-persistence navigation guarantee. Link that documentation PR to ENG-408
and this implementation PR before the feature is released.
