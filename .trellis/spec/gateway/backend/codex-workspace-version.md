# Structured Codex workspace version

## 1. Scope

The Chat provider catalog uses the Gateway workspace credential probe. An installed Codex can authenticate in Settings and still fail the workspace version policy.

## 2. Signatures

`createAgentLauncher().buildLaunch(input)` may await a bounded executable version check for structured Codex launches. The runner receives the version and executable in its existing arguments. Public routes and payloads retain their current shape.

## 3. Contracts

- The managed installer selects `CODEX_VERIFIED_VERSION` (0.162.1). Structured workspace execution accepts that default and the explicitly qualified 0.169.0 when both the exec and app-server contracts contain the exact release.
- Probe the executable being launched with the prepared checkout and environment. Native subscription probes use the isolated launch environment. The runner rechecks the same exact version before starting app-server.

## 4. Validation and errors

- Unknown or unselected version → `agent_version_unsupported` in the workspace installation probe. The Chat catalog suppresses unavailable models.
- Version cannot be verified at launch → fail session preparation. A binary change after preparation fails the runner guard before app-server or its event log starts.

## 5. Cases

- An existing managed 0.162.1 runtime and a compatible owner-installed 0.169.0 runtime both work. A protocol record for an unselected release is insufficient for workspace execution.

## 6. Required tests

Cover both exact releases, unknown and unselected releases, native launch environment, and the runner's binary replacement guard. Local loopback inference exercises the real CLI lifecycle. Account-backed Chat requires its own live acceptance.

Session-manager fixtures with a stub Terminal pass an explicit temporary executable that answers the real version probe. The native launch, cold resume, and startup diagnostic suites use this fixture so they behave the same on CI and on a developer machine with Codex installed.

## 7. Version sources

Use the verified version observed for the chosen executable as the runner's expected version. Passing the install default for every executable can expose a model in the catalog and then reject its first turn.
