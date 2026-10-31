# Security design and qualification plan

Status: proposed controls and acceptance gates, not a security certification. Source baseline: `231eff01cf7f67a0c135653848093c30fda3b90d` (31 October 2026). No deployed probing, attack execution, customer access, or production changes occurred.

## Evidence and limits

A scoped Codex Security Standard source review inspected all 15 TypeScript files under `packages/gateway/src/agent-config` (3,859 lines), grouped into six security surfaces. It established no reportable vulnerability. Assurance remains **partial** because actual inference transport enforcement for DNS changes, redirects, and credential recipients was not established. This does not establish whole-repository security or readiness for air-gapped deployment.

The review used a sequential baseline and investigation because all available agent slots were occupied; it did not have an independent baseline auditor. The account advisory reported no Daybreak program access. **Daybreak Blue did not run.** Require a separate, accessible security review before release; unavailable scan tooling cannot count as a passed gate.

Confirmed existing controls to preserve:

| Boundary | Existing source-backed control | Consequence for the design |
|---|---|---|
| Owner-selected provider endpoint | `packages/gateway/src/agent-config/base-url-policy.ts:40-82` admits HTTPS/public DNS and documents lack of runtime DNS pinning/redirect enforcement. `hermes-adapter.ts:40-70` checks the catalog before sending the configuration mutation. | Internal inference needs a separate administrator-authorized transport policy; do not globally relax this public URL policy. |
| Gateway to Hermes dashboard | `packages/gateway/src/agent-config/hermes-client.ts:47-75,134-159,179-195` constrains loopback/API paths, reads a bounded mode-0600 non-symlink token file, removes incoming authorization/cookies and rejects redirects. Streaming JSON is capped at 1 MiB (`:78-113`). | Keep dashboard administration distinct from inference endpoints and user-facing proxies. |
| Runtime configuration | `packages/gateway/src/agent-config/runtime-controller.ts:94-172,198-281` serializes updates, checks revision, writes atomically and verifies/rolls back switches. `runtime-files.ts:71-108,121-175` uses exclusive temporary files/locks and bounded non-symlink markers. | Enterprise policy updates must preserve revision guards, durable audit and crash recovery. |
| Gateway to host lifecycle helper | `packages/gateway/src/agent-config/host-runtime-control.ts:9-18,120-175,179-202` uses a fixed executable, enum-constrained argv, output/time limits and a constrained token file. | No arbitrary root command or user-supplied executable becomes an enterprise administration API. |
| Gateway to OpenClaw RPC | `packages/gateway/src/agent-config/openclaw-rpc.ts:215-290,365-420,573-682` fixes loopback port/path, checks token/scopes, validates each method, caps request/frame/pending/listener resources and drains at shutdown. | Keep local operator RPC inaccessible to ordinary app and model tool callers. |
| Discovery metadata | `packages/gateway/src/agent-config/hermes-source.ts:225-255` marks profile observations `present_unverified`; `service.ts:188-190` strips native route observations from ordinary settings output. | Model visibility, license entitlement and discovered credentials must never replace execution authorization. |

## Proposed trust model

Protect owner files and Postgres data, personal/org separation, conversations, credentials, IdP signing trust, model endpoint credentials, update trust roots, offline entitlement keys, host execution authority and audit integrity.

Actors are: unauthenticated LAN clients; authenticated members/guests; org administrators; installation operators; untrusted app/MCP/model content; internal model and object-storage services; package/update publishers. An installation operator already controls the machine. Do not claim software can protect secrets from a malicious root operator; distinguish that from an ordinary org administrator or sandboxed app gaining host authority.

| Proposed interface or operation | Authentication / authorization | Required invariant |
|---|---|---|
| Shell, REST, file and WebSocket access | Verified deployment-selected session translated to the existing canonical principal; owner/resource authorization at service boundary | Same checks on all shells and transports; browsers cannot forge platform/native headers. |
| Internal OIDC login/callback | Installation-pinned issuer, client, redirect URI and trust roots; state/nonce/PKCE and bounded metadata/JWKS handling | Issuer/subject are authoritative; token audience and destination must match. No discovery to arbitrary user URLs. |
| Enterprise configuration and inference endpoint changes | Explicit install/org admin role; scoped revision; audit before/after digest; credentials stored separately | Member/app/model cannot register new internal destinations or broaden egress. |
| Model request and tool execution | Existing owner/source/model admission plus endpoint policy and tool/resource authorization | No ambient credential fallback, payer switch, cross-owner context or unbrokered internal network access. |
| Update import/activation/rollback | Local operator authority; trusted signed manifest; exact artifact digest, compatible schema and explicit rollback policy | Download/import success never implies artifact trust; verify before extraction and activation. |
| Backup/export/restore | Scoped operator/owner authority; encrypted destination and recipient verification | Personal/org boundaries persist; restore is authenticated and path/symlink safe; no cross-install secret reuse. |
| EE entitlement import/status | Admin-only mutation; asymmetric signature verification with pinned issuer key and bounded parser | Entitlement is feature access, not data authorization or authentication. It never unlocks another owner's data. |
| Audit export/support diagnostics | Least-privilege auditor/admin access with bounded content and redaction | No raw credentials, prompt contents or customer payloads by default; no required external log sink. |

All new endpoints still require route-specific Zod schemas, `bodyLimit` on mutations including DELETE, coarse client errors, explicit allowed origins, bounded responses, cancellation/timeouts and finite queue/subscriber lifecycle. The table is a design contract; exact routes belong in the implementation-layer API contract before code is added.

## Security work packages

### S1 — Internal inference policy and transport (blocking local AI)

Define an immutable deployment profile and a separate operator-managed inference endpoint registry. Bind each entry to an exact scheme/host/port/path policy, allowed private destination ranges or socket, credential reference, trust roots, provider protocol, timeout/byte/token/concurrency limits and revision. HTTPS with private PKI is the normal LAN profile; any plain HTTP exception must be a deliberate loopback-only deployment choice, never global TLS-disable configuration.

Resolve and enforce the destination at connection time. Pin resolved addresses or use an egress broker that owns that transport; reject metadata/link-local and unrelated services even when ordinary private inference is allowed. Reject redirects, or revalidate and reauthorize every hop while dropping credentials whenever the recipient changes. Explicitly cover proxies and `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` behavior. A successful DNS preflight does not satisfy this work package.

Run a real local-model spike against the exact shipped harness/protocol before choosing the adapter. Exercise streaming, tool schemas/results, cancellation, malformed/oversized responses, context exhaustion and restart/resume. Admission must bind owner, selected model/source and endpoint revision to the request. Missing/incompatible local models stop with a safe actionable error; they cannot trigger commercial-cloud inference.

### S2 — Identity, policy and tenant separation

Introduce a deployment-selected identity adapter rather than an authentication bypass. Retain secure standalone owner login; add enterprise internal IdP as an independent composition. Require identity mapping for HTTP, browser WebSocket, Electron, mobile, CLI and shared collaboration. IdP outage, missing issuer keys and conflicting deployment settings fail closed. Test role changes, employee offboarding, token expiry/revocation, owner switching, existing sessions and archived/shared resources.

Keep entitlement checks separate from resource authorization. Loss/expiry of an EE entitlement must preserve owner export, recovery and access to unlicensed core data. Decide feature restriction, offline clock skew, manual renewal and rollback behavior explicitly; no internet activation/heartbeat can be required for an air-gapped license. Never put private entitlement signing keys in the runtime.

### S3 — Supply chain and imported content

Use signed release manifests with an offline verifiable trust root, exact digest/length, platform/architecture, schema compatibility, component/model manifests, license notices, SBOM and build provenance. Cover all installer and first-use transitive downloads. Verify tar/archive paths, symlinks, hardlinks, file modes and expansion quotas before privileged extraction. Key rotation/revocation and security advisories need an explicit operator-import process.

Treat models, tokenizer/config files, package metadata, plugins, skills, MCP servers and app bundles as imported code/data with different authority. Disable automatic remote model/package/code downloads and executable custom-provider settings for ordinary users. Avoid unsafe model deserialization; prefer vetted formats/loaders and disallow arbitrary remote-code loading. Package-install scripts and native extensions need reviewed provenance and an explicit sandbox policy, even from an internal registry.

### S4 — Host, process and network containment

Run services under dedicated least-privilege identities; isolate owner/org resources and privileged host helpers. Enforce the disconnected profile with host/network egress controls, not just UI hiding or fetch wrappers. Test IPv4, IPv6, DNS, UDP, HTTP/WebSocket, subprocesses, model workers, browser processes and background jobs. The local AI server, IdP, database, object store and internal package mirror are allowlisted services, not authorization to reach the entire LAN.

Document CPU/GPU/RAM/disk/process limits, queue fairness and admission limits; model failure must not exhaust gateway resources or bypass tool approval. Preserve the existing broker/sandbox boundaries for untrusted apps and shared scopes. Privileged-only provider configuration does not justify granting model-generated arbitrary URL/shell requests that authority.

### S5 — Secrets, audit and recovery

Keep internal credentials outside user-readable config exports and browser state. Define filesystem ownership/modes, key rotation, secret injection and redaction. Minimize model-context and audit payload retention. Local logs/SIEM export must work without a public collector; record admin configuration and denied egress with safe metadata. An append-only/tamper-evident audit design must state its trust in the host operator rather than claim protection against root.

Restore into a clean disposable installation and verify scoped data, identity mapping, runtime endpoints, artifact trust, protected home paths and secret regeneration. Define local PKI, DNS and time services: certificate renewal, internal CA rotation, IdP key refresh and clock skew are operational dependencies even without internet. Require bounded disk cleanup, safe temp-file handling and tested recovery from interrupted migrations/updates.

## Required adversarial acceptance cases

Write regression tests before production changes. Exercise production producer/consumer boundaries; a mock URL-policy test alone cannot qualify the actual inference transport.

| Scenario | Observable passing result |
|---|---|
| Member/app/model supplies an internal inference URL | Rejected unless the caller has the explicit endpoint-admin authority; ordinary arbitrary fetch protections remain unchanged. |
| Approved hostname changes DNS destination or returns a redirect | Connection policy blocks unapproved recipients; no request body/credential reaches them. Test IPv4, IPv6 and mixed DNS answers. |
| Local model fails, disappears or returns invalid protocol | Safe bounded failure, owner selection preserved, no external fallback or credential/payer substitution. |
| Malicious provider catalog/model response | Size/schema/rate limits and safe client error; discovery cannot authorize execution. |
| Revoked/expired/wrong-issuer/wrong-audience token, forged owner/header, browser WS | All transports deny access without leaking resource existence or accepting stale org membership. |
| Untrusted package/app/model import, archive traversal/link/bomb | Import rejected before privileged writes or execution; bounded cleanup leaves protected owner data intact. |
| Invalid entitlement, unknown key, expired license, skewed clock | Deterministic documented behavior; no data loss, weakened auth or required network activation; owner export/recovery remains usable. |
| Signed update wrong digest/architecture/schema, interrupted activation or rollback | Reject incompatible bytes; previous working release remains recoverable; owner home survives. |
| Internet blocked before initial install and throughout normal use | Install, login, Chat/tools/apps, scheduled tasks, reboot/resume, backup/restore and upgrade pass with packet/DNS evidence; required paths do not attempt external connections. |
| External telemetry, feature flags, update/catalog/plugin checks | Disabled at startup in airgap mode; no retry storm or hidden readiness dependency. |
| Resource pressure, hung workers, dead sockets, cancelled jobs | Caps, cancellation and shutdown drains remain effective; gateway stays available and secrets stay isolated. |
| Hosted/community builds run alongside EE work | Shared security tests pass; hosted behavior is unchanged; removing `ee/` still builds/tests core without enterprise imports. |

## Review and release gates

1. Architecture review maps every affected route, resource owner, subprocess and network dependency. Resolve the actual inference transport gap before local-provider enablement.
2. Security implementation review validates auth/principal parity, endpoint policy and secrets; CI runs the hosted, standalone and enterprise build/test matrix on shared-core changes.
3. A separate authorized security review covers gateway/auth, collaboration, scope-runtime/bots, app/MCP/browser/terminal bridges, platform composition, native-client identity, installer/update import and backup/restore. The small completed agent-config scan cannot substitute for these.
4. Use Daybreak Blue when access is granted and the tool is actually available; preserve scope/revision/report, validate findings, fix/report accepted risks, and rerun changed boundaries. Until then use an available independent security review and keep the Daybreak-specific task explicitly pending.
5. Run a network-denied installation and lifecycle exercise against exact signed bytes. Retain traffic captures and actual screenshots/recordings for each affected surface outside the repo, linked in the PR and authorized tech evidence channel. Missing devices/runtime access blocks qualification of that surface.
6. Require no unresolved release-blocking critical/high findings; medium findings have named remediation/acceptance owners and documented scope. Pass Greptile/current-head CI, human security and operations review, exact-artifact rollback/restore, and public documentation update before promoting a supported enterprise release.

These are completion checks for future implementation. None is marked passed by this planning document.
