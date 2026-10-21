# U8: Hermes native app text completion

## Goal

Complete apps' exact Hermes native profile selections using fixed text-only HTTP,
without launching an agent, loading owner hooks/context, refreshing tokens, rotating
pools or falling back to another account/provider. All app surfaces use the existing
shared route contract and common canonical V3/Settings truth.

## Authority and scope

The gateway owner/app grant and exact harness/account/access-source/model selection
remain authoritative. The native source must be a Hermes-owned profile with null
portable account identity, an enabled installed Hermes instance and an eligible
canonical native provider/model observation. Provider choices are bounded to
Anthropic, OpenAI API, OpenRouter and already-fresh singleton Hermes ChatGPT OAuth.
The `.hermes` default profile must be selected; named profiles and ambiguous pools
fail closed. A ChatGPT grant may use the legacy singleton store, or the current
CLI exact-one `manual:device_code` OAuth entry when no singleton exists. No other
pool selection or rotation is permitted. Native config/auth files are bounded, symlink-safe and fingerprinted.
The selected native provider configuration must match its fixed sanctioned
endpoint/protocol; executable/env credential expansion and overrides fail closed.
App model selection is exact and must be in the live eligible native catalog.
Global Inbox runtime/messaging selection is not app authority.

## Implementation units

- U8a: New app-only native credential proof. Combine exact Settings/V3 selection,
  fresh Hermes native observation, fixed default-profile config and selected static
  credential or fresh OAuth access token. Revalidate config, active profile, auth
  and secret file fingerprints before admission and after response. Keep the
  refresh grant private and unused; reject ambiguous credential pools. No general JEV or
  agent-session execution.
- U8b: New owner-scoped fixed HTTP executor. Reuse the generic native writer fence
  for `hermes`, which already guards native Settings key/account writes. Probe
  under the same fence and fail closed while another writer owns it. Use exact
  fixed no-tools protocol bodies, 30s abort deadlines, bounded streaming response,
  no redirects/retries and final text/tool/model/status validation. Release the
  fence after real HTTP work drains; uncertain cancellation must remain fenced.
- U8c: Compose route discovery/generation in app-ai runtime and supported native
  projection. Filter owner fixed grants before probes; batch readiness by native
  provider/profile. Discovery uses no paid calls. Under own lease revalidate
  durable owner grants/Settings plus direct file and native catalog proof, avoiding
  recursive discovery. Preserve legacy grants, Pi/paired behavior and managed
  funding paths. Root owns server dependency wiring and shutdown.
- U8d: Update app capability support docs/breadth boundaries and verification.
  Parent keeps the separate canonical public docs PR deliverable.

Execution note: tests first, verify red before implementation. No source edits to
other workers' owned files; no commits/staging by the shared-directory worker.

## Verification

Synthetic default profiles and local stub HTTP prove all supported protocol bodies,
exact headers/account/model, no tools/context/refresh-token propagation, policy
revocation before/after response, profile/config/key/account replacement,
malformed/expired JWTs, named profiles, pools, unsafe endpoints, missing/stale
canonical observations, writer contention, timeout/cancellation, bounded text and
clean shutdown. Runtime POST tests cover discovery→exact selection→proof→HTTP and
unrelated route preservation. No customer credentials or paid calls in tests.

## Auth and resource limits

The existing gateway AI routes admit before owner/app-policy reads and bind to the
configured owner principal. The adapter accepts only validated exact selections;
provider URLs are constants, never app input. Native file reads are capped at64KiB;
responses at256000 bytes, at most16384 read chunks, and returned text at64K characters. At most one Hermes request
per adapter and durable owner profile fence. Every HTTP wait has an abort deadline.
No secrets cross the gateway/app response boundary. No new persistent store is added.

## U8 result

Implemented with no paid calls: exact default native-provider key or fresh single
ChatGPT account proof, fixed HTTP only, shared durable writer fence, complete
JSON/Codex SSE validation, cancellation-drain retention and exact owner policy
revalidation. App model choices may differ from the native default model when the
fresh exact provider catalog admits them. A post-response native catalog removes
retired models; stale snapshots consumed by other discovery work are renewed
through authoritative readers. Model aliases are never accepted by prefix guesses.
The native provider itself must match default profile configuration; custom
endpoint/credential overlays and expiring or ambiguous OAuth remain unavailable.

Server composition: `createHermesAppCompletion({homePath,runtimeSource})` uses the
existing dedicated system Hermes source. Runtime injects `hermesCompletion`, and
gateway shutdown closes it before native dependencies. The original shared app
contract supplies all five surfaces; no new client protocol is necessary.
