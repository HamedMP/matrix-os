# Hermes dependency admission (ENG-61)

Jev Inbox runs use the owner's selected Hermes primary-model route. Jev itself remains a separate Matrix Gateway decision call. A Codex subscription must not be blocked merely because an unused optional Anthropic SDK is absent.

## Contract

Resolve the owner-authorized Hermes route before dependency admission. The trusted route, never prompt content or a caller-provided Python package name, determines optional dependencies. The spike-verified Hermes source pin, source cleanliness checks, isolated Python flags, private cache, bounded execution, and credential isolation remain mandatory.

The pinned Hermes runtime uses OpenAI as a core dependency. Every supported route checks that core SDK. Only the native Anthropic route requires the optional Anthropic SDK. Other supported routes must not import Anthropic during their dependency probe. Unknown routes fail closed. Required dependency versions are part of the reviewed runtime contract, not independent literals scattered through installer and verifier code. Do not silently accept arbitrary installed SDK versions.

Host installation and upgrades must provision the reviewed dependency contract or derive it from the verified upstream dependency metadata. Re-running installation must not leave a supported route dependent on a manual venv repair. Provider requirements must stay tied to the trusted pinned release rather than owner-edited configuration.

No endpoint, credential source, Gmail grant, Jev funding policy, or mailbox operation changes. Checking dependencies does not authorize a Jev charge or Gmail write. Failed startup cannot be reported as successful classification.

## Verification and delivery

- Reproduce the unconditional optional-SDK failure before implementation.
- Exercise real isolated Python with OpenAI present and Anthropic absent: Codex admission succeeds and owner site startup hooks do not execute.
- Missing or incompatible required core dependencies fail; missing or incompatible Anthropic dependencies fail only on the Anthropic route.
- Verify authoritative route wiring and all existing source-integrity checks remain active.
- Verify provisioning restores required packages after a supported upgrade.
- Run focused regression tests, type checks, pattern checks, and required CI.
- Validate the installed Linux runtime and an immutable Preview host bundle through Electron Desktop. Record startup checks separately from an actual Jev tool result and independent Gmail label readback.
- Open a separate `FinnaAI/matrix-os-site` documentation PR explaining Jev's selected primary-model route and runtime dependency troubleshooting. Never include private incident identifiers or access details in public docs.

PR #2071's MCP catalog schema fix remains independently reviewable. This dependency change must not be credited with that catalog repair or with a full-mailbox acceptance test that was not performed.
