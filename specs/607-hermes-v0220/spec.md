# Hermes v0.22.0 native compatibility

ENG-306: https://linear.app/matrix-os/issue/ENG-306/upgrade-matrix-hermes-to-v0220-and-verify-native-compatibility

Upgrade the host installer and native integration to official source commit
`e06df9c2eae6901f4c88f464e0ae6e753c0428b8` (v0.22.0).

## Behavior and boundaries

- Resolve PM's committed Python generation for Chat, restricted Jev execution,
  native account metadata, key setup and Codex reuse. Preserve legacy venv
  support before a PM generation exists; malformed or missing committed
  generations fail closed instead of loading stale dependencies.
- Use supported upstream installer arguments and PM-owned optional dependencies.
  Preserve owner configuration, sessions, credentials and disabled markers.
- Adapt the read-only Codex credential helper while preserving endpoint binding;
  never refresh credentials or send a custom-host token to the official usage API.
- Preserve ENG-298/#2593's ownership of Codex/npm reconciliation. Verify overlap
  against that PR without copying unrelated implementation.

No endpoints or authorization rules change. Existing owner authorization remains
the source of truth. Bound file reads and subprocess work, preserve Python
isolation, and clean temporary test homes. Production calls and Electron Desktop
testing require the coordinator's queue. No new credentials, paid inference,
deployment, merge or Slack messages are authorized.

## Acceptance

Tests cover committed/legacy environments, corrupt records, path escape, symlinks,
restricted imports, immutable pins, installer status, native credential endpoints,
Chat streaming/cancellation/continuation, app text execution and MCP/tool events.
Run actual upstream Python/CLI/stdio in an isolated home without owner credentials
or paid inference. Record exact versions and distinguish local protocol fixtures
from provider-backed acceptance. Collect coordinated runtime screenshots and
English cases/results on Linear. Publish a draft implementation PR, obtain
current-head Greptile 5/5 with no unresolved findings, then formal CI.

Affected clients share the gateway: Web Canvas, Web Desktop, Electron Desktop,
Web Mobile and Native Mobile. No renderer visuals change; actual native execution
qualification remains required and missing surfaces must be reported explicitly.
Recommend Hamed review the upgrade and npm coexistence before landing.

Public documentation: update `docs/dev/hermes-matrix-skills.md` for repository
integration details; prepare a separate `FinnaAI/matrix-os-site` documentation PR
if public installation/provider behavior changes. Do not recreate website docs
inside this repository.
