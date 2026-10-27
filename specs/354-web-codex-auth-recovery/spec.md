# Web Desktop Codex auth recovery (ENG-354)

## Goal and journey

Settings and Chat refresh native provider evidence when Web Desktop opens or
returns to the foreground. A Codex CLI credential discovered in Terminal is
shown as authenticated. If Matrix execution consent for that exact native
account generation is missing, Settings offers an explicit owner action to use
the account in Matrix. Completion revalidates the native account and saves the
existing Codex route and consent through the provider settings coordinator.
Settings logout uses the same resolved Codex executable as runtime discovery,
then refreshes the visible state after any failed attempt.

All six Chat provider entries remain inspectable when unavailable. Hermes
recovery names Hermes's own login; Matrix AI, Codex and API-key credentials do
not authorize Hermes. The public documentation repository is excluded by the
ticket's authoritative `Repos: matrix-os` scope.

## Security architecture

| Route | Authentication and authority | Change |
| --- | --- | --- |
| `GET /provider-settings?refresh=true` | Existing authenticated principal; native account details only for exact runtime owner | Reprobe CLI and project current consent/readiness. |
| `POST /provider-settings/actions` with `complete_native_codex` | Existing authenticated principal **and** exact runtime owner ID | Revalidate current terminal-method Codex metadata, target harness/source and owner revision before committing consent. |
| `POST /provider-settings/actions` with `logout_account` | Existing provider settings authorization and lifecycle principal proof | Resolve the configured Codex executable used by discovery; reject changed or unverifiable account proof. |

The existing strict Zod mutation schema bounds IDs, idempotency keys and
revisions; the existing body-size limit applies. Server errors remain generic.
Lifecycle diagnostics contain only phase, reason and provider kind, never
account identity, executable path or credentials. Login and logout run behind
the native profile write lease and existing command timeout/output limit.

## Integration wiring and failure modes

`server.ts` resolves the Codex executable once and injects it into both the
credential observer and lifecycle coordinator. The collaboration route binds
the native completion action to its exact runtime owner resolver. The store
serializes the mutation, checks the current revision and current native
metadata, applies the existing coordinator change, and writes the configuration
atomically with a bounded idempotency receipt list. Crash or runtime failure
before the write leaves the former consent in place; existing rollback handles
runtime changes that cannot be persisted. A stale account principal aborts
logout before the CLI command runs. Settings reprobes after rejection and shows
a safe retry message.

Foreground refreshes use the existing request cancellation and deduplication
paths. Terminal activity while the Web app remains in focus is visible through
its explicit refresh control or settings-change event. No new long-running
polling loop, file store, external data flow, or unbounded buffer is added.

## Acceptance and validation

- Native CLI credentials and Matrix execution consent are distinct in Settings
  and Chat; Matrix AI and other provider routes remain independent.
- Completion works only for the current verified terminal Codex account and
  exact owner; failed proof, stale revision and switched account grant nothing.
- Settings logout acts on the executable used for discovery and rechecks the
  account after rejection.
- Web mount, reopen and foreground return force provider refresh; every picker
  entry can show its unavailable state, including Hermes-specific recovery.
- Integration tests cover route authorization, completion, refresh, logout
  identity, picker behavior and provider independence. Matching-build live Web
  Desktop login/logout evidence and deployed capability responses remain a
  handoff gate when an authenticated preview runtime is available.
