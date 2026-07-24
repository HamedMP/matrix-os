## Invariants

- Matrix OS Chat remains the Claude Agent SDK V1 kernel; `hermes | openclaw` selects only the optional messaging-agent runtime.
- Existing `GET/PUT /api/settings/agent` model/effort clients remain compatible; omitted extended fields are unchanged.
- Runtime failure or absence never prevents Chat or gateway startup and never silently changes the owner's selected runtime.
- Provider credentials are write-only through trusted services, never returned to or persisted by a renderer/mobile client.
- Every public boundary is strictly validated and bounded; every mutating HTTP route applies `bodyLimit` before parsing.
- Client errors are bounded and provider-neutral; no raw upstream errors, credentials, account identifiers, internal hosts, or filesystem paths are exposed.
- Matrix OS room permission revisions, cancellation, controlled replies, and audit remain authoritative for every messaging runtime.
- Runtime transitions are serialized, health-gated, rollback-safe, and cannot deliver one event to both runtimes.
- Owner configuration and runtime state remain under `$MATRIX_HOME`; no new Matrix embedded database or ORM is introduced.
- Kernel prompt remains below 7K tokens.
- This PR stays within 3,000 additions and 50 files, uses TDD, and will not merge below Greptile 5/5 on its exact head.
- Deployment uses the VPS-native immutable host-bundle path and is verified on a `preview-vps`; no Docker customer-runtime rollout.
