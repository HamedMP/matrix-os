# Data Model: Elixir Symphony Runtime

## SymphonyServiceState

- `status`: `starting | ready | unavailable | degraded`
- `version`: adapted runtime version
- `boundOrigin`: loopback origin used by the gateway, never browser-visible as a direct target
- `matrixHome`: owner home root, expected `/home/matrix/home`
- `workspaceRoot`: Matrix-managed Symphony workspace root
- `credentialStatus`: `connected | setup_required | unavailable`
- `lastHeartbeatAt`: service heartbeat timestamp
- `runs`: bounded list of `SymphonyRunSummary`
- `limits`: log/run/event caps applied by the service

## SymphonyRunSummary

- `runId`: Matrix/Elixir stable run identifier
- `issueIdentifier`: external issue key such as `MAT-32`
- `issueTitle`: browser-safe title
- `status`: `queued | running | needs_attention | done | stopped | failed`
- `sessionId`: Codex app-server session identifier
- `threadId`: Codex thread identifier
- `turnCount`: number of observed turns
- `latestEvent`: coarse status event
- `workspacePath`: Matrix-owned path under `workspaceRoot`
- `workpadUrl`: Matrix or Linear workpad URL when available
- `allowedActions`: action list such as `refresh`, `stop`, `open_workspace`, `open_workpad`
- `updatedAt`: timestamp

## SymphonyIssueDetail

- Extends `SymphonyRunSummary`
- `logs`: bounded event/log entries with redacted text
- `attempts`: retry count
- `attentionReason`: coarse reason for setup/action required
- `links`: issue/workspace/workpad links safe for the Matrix app

## CredentialBridgeState

- `provider`: `linear`
- `status`: `connected | setup_required | unavailable`
- `source`: `matrix_platform | pipedream | local_fallback`
- `lastCheckedAt`: timestamp
- `clientMessage`: generic setup or unavailable text

## LegacyRunnerMigrationState

- `legacyConfigFound`: boolean
- `migrationAction`: `ignored | migrated_non_secret_config | blocked`
- `notes`: bounded operator-safe notes
