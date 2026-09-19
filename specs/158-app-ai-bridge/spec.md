# App kernel compatibility and AI text bridge

## Problem and scope

Sandboxed apps cannot call the user's model through the native activity-only
`gatewayFetch`. Removing that misleading capability does not supply AI inference.
Provide `window.MatrixOS.ai.generate({ prompt }) -> Promise<{ text }>` in Web
Desktop, Web Canvas, Web Mobile (shared AppViewer), and Electron app views.
Native Mobile does not currently implement this app-window bridge.

This change supports the existing Matrix kernel credential chain: owner API key,
owner Claude login profile, or Matrix-funded access. It does not expose Codex,
Hermes, OpenCode, Pi, or OpenClaw agent sessions as text-completion APIs. It does
not fix file sync or grant file access. Customer app source is unavailable; its
Refresh action and installed version must be verified before customer recovery is claimed.

## Legacy kernel task compatibility

Preserve `MatrixOS.generate(context): void` in Web and restore it in Electron.
It submits `[App: <trusted identity>] <context>` through the shell's existing
kernel WebSocket dispatcher. It does not return text and is not an alias for
`ai.generate`. Electron binds identity to the registered top-level app view,
binds each registration to the main-process authentication generation (all app
capabilities reject stale registrations after logout/expiry/reauthentication),
validates a nonempty context of at most 32K characters, and caps submissions at
10 per minute per desktop bridge. Main forwards a typed event only to the trusted
shell. Shell rejects events for a different selected runtime and unsubscribes
when the kernel connection is disposed. Runtime changes close app views.

The legacy path retains existing authenticated kernel task semantics, including
tools and kernel configuration, independently of the new text API's opt-in policy.
No arbitrary gateway access or credentials are exposed. Each Electron app task
starts a separate kernel request without taking over the currently selected chat.

## Owner grant and model selection

The owner explicitly creates `system/app-ai.json` under their Matrix home:

```json
{"apps":["my-app"],"model":"claude-sonnet-5"}
```

The apps list contains bridge app identities (the app path relative to `apps/`,
without `/index.html`). The model uses the existing kernel model allowlist.
Matrix-funded access permits only its supported Sonnet model. No silent provider,
model, or credential fallback is added. The default is denied; app manifest
permissions cannot grant this access. Invalid policy fails closed. Policy is
re-read on every call and after credential resolution; removing an app revokes
future calls, not an already-running generation.

Only the configured runtime owner may call this endpoint. Collaborator grants,
permission UI, streaming, files, tools, and provider-specific agent APIs are deferred.
Do not ship a default policy granting every app access.

## Contract and auth matrix

| Boundary | Authentication and identity | Limits |
| --- | --- | --- |
| Web iframe -> parent | Existing exact iframe source/origin/app match; trusted parent injects app identity | Only prompt; endpoint aliases rejected |
| Electron preload -> main | Registered sender, main frame, exact gateway origin and registered app route | Strict shared input schema; no credentials exposed |
| POST /api/bridge/ai | Existing gateway auth plus configured owner principal and owner app allowlist | 64 KiB body, 32K prompt chars, 2 concurrent calls, 10 calls/minute per runtime |
| Gateway -> SDK | Existing kernel credential resolver | 30s deadline, lease timeout if shorter, $0.25 maximum budget, one turn |
| SDK -> app | Only validated text | 64K output chars; generic errors |

The SDK runs in a unique temporary directory with no tools, no MCP servers, no
project/user settings sources, no kernel prompt/context, and no durable session.
Credentials stay server-side. Cleanup closes the SDK iterator and removes the
scratch directory on success, failure, or cancellation.

## Composition and extraction

Keep all new gateway behavior in `app-ai/`; `server.ts` only registers it.
Keep new inference behavior in `kernel/app-ai.ts`; do not extend the kernel's
large tool-enabled options factory. Native bridge remains one focused sender
registry; AppViewer delegates identity serialization to `app-ai-request.ts`.

## Validation and delivery

- Route validation, denial, body limits, redacted errors and concurrency tests.
- Owner policy and credential/model selection tests.
- Actual generated Web bridge script -> MessageChannel -> route roundtrip with
  injected inference; native sender/requester and preload wiring tests.
- SDK options, error, abort, and scratch cleanup tests using a mocked SDK.
- Typecheck, patterns, focused and full test runs; desktop packaging build.
- Companion public docs PR in FinnaAI/matrix-os-site, `content/docs/guide/apps.mdx`.
- Before rollout: approve an app on a test VPS, invoke a real model from both Web
  and Electron, then test the customer's actual Refresh action. Unit tests do not
  establish live model success or customer recovery.
- PR targets main; any recovery release must cherry-pick its reviewed commit onto
  the agreed #1664 baseline and verify both artifacts there. No deployment here.
