# Integration and security boundaries

Status: design obligations for OM-287, not an implementation or a deployed contract. Product requirements live in [spec.md](spec.md); this annex records constraints needed before implementation. Reuse existing services where possible; final wire shapes and new route names require an implementation plan.

## 1. Inputs and ownership

| Input | Authoritative owner | Required validation |
| --- | --- | --- |
| Exact Desktop artifact, minimum bundle, supported devices | Release metadata bound to the downloaded artifact | Schema, bounded fields, identity/digest, supported device, withdrawal state |
| Release-set identity and paired bundle | Release service | One consistent snapshot, immutable target identity, both targets available to the same audience |
| Current Desktop minimum | Compiled artifact metadata or tested legacy release mapping | Never infer from source ancestry; absent mapping stays unknown |
| Running/installed bundle and health | Authenticated selected runtime | Stable runtime identity, running process evidence, freshness, distinct installed/running identities |
| Eligibility | Server-side authenticated audience/channel/rollout policy | Actual identity and current entitlement; renderer claims do not grant access |
| Reverse and Platform compatibility | Release/Platform/Gateway verified support evidence | Explicit support or unknown; minimum ordering alone is insufficient |
| Accepted operation and status | Runtime update service | Account/runtime scope, stable operation identity, idempotency, serialized admission |

Do not use source SHA, build timestamp, baked build channel, or equal protocol constants as compatibility proof. Use the canonical comparator for each component's own version scheme; reject malformed versions. Stable membership may come from promotion of an artifact originally built for dev.

No new platform signing protocol, capability registry, or database schema is chosen by this spec. Integrity, authentication, and expiry must be established through the existing trusted distribution and runtime paths, with gaps documented before implementation.

## 2. Authorization matrix

These are existing integration boundaries to audit, not claims that the baseline already implements every check.

| Route / boundary | Required auth and authority | Public |
| --- | --- | --- |
| `GET /api/system/info` | Existing gateway authentication plus selected-runtime access; authenticate before trusting observations | No |
| `GET /api/system/update` and `GET /api/system/releases` | Existing runtime access plus server-side audience filtering for returned candidates | No |
| `POST /api/system/update` | Existing runtime update/manage authorization, exact-target eligibility and transition admission; idempotent operation handling | No |
| Update-task status, through existing or additive authorized status route | Same account/runtime scope; a task ID alone grants no access; final route remains an implementation dependency | No |
| Paired release/compatibility projection | Server computes identity/eligibility; do not expose restricted candidates through a public projection | No |
| `update:install` local IPC | Trusted Electron sender; main process validates expected exact target, selected-runtime proof, and current readiness | No |
| Public stable release/download feed, if retained | Existing signed/integrity-checked distribution; download access never grants cloud management rights | Per existing distribution policy |
| Platform control-plane recovery | Existing service/user authorization; owner-scoped recovery even when business APIs are incompatible | No |

Final endpoint auth mechanisms and IPC sender registration must be traced at implementation time. Do not replace authorization with hidden UI. A missing server-side eligibility or recovery contract blocks enabling the coordinated action, rather than being deferred as an optional security improvement.

At route and IPC boundaries validate version/artifact IDs, stable runtime IDs, operation IDs, state discriminants, and target identity. Use bounded schemas and body limits before parsing mutation bodies. Do not accept arbitrary download URLs or filesystem paths from the renderer. Credentials travel only through existing credential plumbing, never URLs, plan files, logs, analytics, or error messages. Safe allowlisted reason codes reach users; diagnostic detail stays in authorized logs.

## 3. Integration wiring

1. App startup restores the local operation reference and bounded dismissals; restoration never resumes an install solely from persisted ready state.
2. Authenticated runtime selection creates a scoped observation generation. Fetch running state and eligible release information with cancellation and deadlines.
3. A shared decision layer derives compatibility, availability, actionable plan, and notice state. Indicator, modal, Settings, and menu consumers read the same result.
4. User initiation binds account/runtime, release snapshot, exact targets, and transition evidence. The gateway validates admission and owns serialized cloud task submission/status.
5. Cloud progress is reconciled with actual running identity and health. Main-process installation admission independently validates the exact staged Desktop target and current preconditions.
6. All install triggers, including custom quit handling, use that admission. Existing no-argument install IPC needs an additive expected-target/operation contract or equivalent trusted plan lookup; final shape is for implementation planning.
7. After restart, actual Desktop identity and a fresh runtime observation determine completion. Reset observation generations on account/runtime switch, not merely on API-client object changes.

Use existing dependency injection and typed IPC; no cross-package globals. No new constructor or service is prescribed now: implementation planning must identify actual registration/initialization owners and verify dependencies at registration. Tests must cover the real composition, not only isolated helpers.

## 4. Failure and concurrency contract

- Proposed request deadlines: 10 seconds for metadata/status/admission responses; 30 seconds for bounded artifact metadata/file requests where applicable. Installer/download progress uses the updater's existing transport policy, with a documented bounded inactivity timeout before integration. Do not apply a 30-second total cap to a full Desktop package download.
- Proposed cloud readiness observation window: 10 minutes per active wait. Timeout means waiting could not be verified, not that an accepted job was canceled or failed. Offer status reconciliation; never auto-resubmit an uncertain mutation.
- At most one active operation per runtime. The server must atomically admit or return the existing compatible task; incompatible concurrent targets return a safe conflict. Multiple Desktop windows cannot establish a distributed lock through renderer memory.
- An idempotent submission identity must survive loss of response and app restart. If the existing updater cannot reconcile it, that interface gap must be resolved before enabling one-action updates.
- Account/runtime/operation generation fences apply to responses, follow-on cloud steps, and Desktop installation. Canceling client observation does not revoke a server-accepted job.
- Revalidate target withdrawal, entitlement, artifact identity, and runtime readiness immediately before installation. If the feed advances, keep the admitted target only while still valid; otherwise stop and surface a refreshed plan for user action.
- Do not automatically downgrade or roll back owner databases when cloud succeeds but Desktop fails. Retry the remaining component, preserving verified intermediate support.
- If a supported runtime is known incompatible with a global Desktop target, block and explain it. Unreachable runtimes are unknown, not known-bad; release support guarantees and the selected-runtime verification policy remain required.

The values above are explicit proposed defaults for review. Implementation must not use unbounded waiting or interpret a timer as proof of cloud failure.

## 5. Resource and data lifecycle

- Proposed bounds: one active UI operation per selected runtime; at most 20 completed local operation summaries retained for 7 days; at most 100 dismissal records retained for 30 days. Evict oldest expired entries first. Known unsafe compatibility restrictions never depend on dismissal-cache retention.
- Active accepted operations are reconciled before pruning their local summary. The server owns durable task retention and status reconciliation; final retention is an integration dependency.
- Tear down timers/listeners/observers on runtime switch, window disposal, and shutdown. Discard late responses by generation. All in-memory collections must have a documented cap and eviction policy.
- Persist local progress atomically using the established storage owner; never persist credentials. Installer caches use existing cleanup/integrity rules; this spec introduces no separate unlimited artifact cache.
- Cloud updates may replace system artifacts only; preserve owner files, Postgres data, drafts, conversations, layout, and sessions. No production rollout or data migration occurs in this document PR.
- Release/runtime services receive only update-related identity, version, device, eligibility, and operation data required for this workflow. No Chat content or unsent drafts are sent for compatibility decisions; diagnostics use bounded safe fields.

## 6. Future verification checkpoint

Before product changes: failing tests for false prompts, unavailable candidates, minimum requirements, reverse/Platform results, safe ordering, stale target/runtime, uncertain acceptance, quit bypass, and recovery. Existing tests that require commit alignment must be deliberately replaced, not disabled without replacement.

End-to-end integration must exercise renderer initiation → scoped gateway admission → accepted task/status → running-version and health observation → trusted Desktop installation admission → restart recovery. Cover every install entry, an old/new intermediate pair, and an ordinary account without canary/dev access.

Actual acceptance then uses a signed packaged Electron Desktop and a disposable VPS with exact reviewed versions. Test cloud reconnection, installed-versus-running lag, interruption, task recovery, preserved drafts and keyboard behavior. These are future checks, not results claimed by this spec. Production rollout, customer outreach, and merge require their separate authorized work.

## 7. External readiness dependencies

- Consistent paired-release publication/readiness and per-artifact minimum metadata, with tested legacy mappings.
- Release-tested old-Desktop/new-bundle and Platform/old-bundle support, including recovery endpoints through transitions.
- Server-side eligible exact-target updates with idempotency, concurrent admission, status reconciliation, and running identity evidence.
- Existing dev naming mapped to the agreed canary policy without silently moving external accounts.
- A reviewed multiple-runtime support policy and true package discovery evidence for the separate canary issue.

Missing dependencies must produce explicit unverified/preparing/no-repair states as appropriate. This spec-only PR can be reviewed before those services exist; the coordinated update feature cannot be declared ready to ship without them.
