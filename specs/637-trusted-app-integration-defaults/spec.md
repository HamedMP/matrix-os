# Trusted app integration defaults

**Linear:** [ENG-402](https://linear.app/matrix-os/issue/ENG-402/fixapps-default-trusted-apps-to-connected-integrations)

## Goal

An owner connects an integration to Matrix once. Every visible personal app
that Matrix has classified as `first_party` can immediately discover and call
the live actions for that connection, without a second per-app grant step.

## Behavior

- The authenticated owner and the trusted host-stamped app identity remain
  mandatory. Apps never choose their own bridge identity or receive provider
  credentials.
- A visible personal app created in place by Matrix with
  `listingTrust: "first_party"` receives the current integration catalog by
  default, including read, write, and destructive actions exposed by that
  catalog. Install and fork paths host-stamp provenance, so imported code
  cannot select this default for itself. Launch trust remains separate and is
  preserved, so supported first-party and verified-partner installs still open.
- `system/app-capabilities.json` remains an owner-controlled explicit policy.
  When it contains an entry for an app, that entry restricts the app to the
  listed services and actions. An empty `services` object revokes integration
  access for that app.
- Folder-path and manifest-slug identities are resolved to the same installed
  app before policy lookup. Policies found under both aliases are intersected,
  so Web and Electron callers cannot bypass the stricter owner rule.
- Apps without a matching trusted personal manifest remain denied unless the
  owner has explicitly granted them a policy entry. Community, hidden, shared,
  missing, duplicate, and malformed app identities fail closed.
- Trust and explicit policy are re-read before provider execution so a
  downgrade or revocation that occurs during discovery prevents the call.
- Connecting another account or integration requires no app-policy rewrite;
  the next request reads live inventory and catalog state.

## Authorization matrix

| Boundary | Authentication and authorization | Public |
| --- | --- | --- |
| App iframe/WebView -> host | Exact registered frame/session; host stamps the installed app identity | No |
| Host -> `/api/bridge/capabilities` | Authenticated computer owner; trusted-personal default or exact owner policy | No |
| Gateway -> integration broker | Existing owner delegation and immutable connection ID | No |
| Broker -> provider | Existing owner OAuth/account connection and live action catalog | No |

## Safety and resource limits

The existing strict Zod request schemas, 64 KiB body limit, eight concurrent
requests, 120 requests per minute, provider timeouts, bounded replies, exact
account selection, and safe client errors remain unchanged. Read actions use
the read transport; non-read actions use the mutation transport. Provider
credentials and raw errors never enter app code.

Integration-default trust comes from the freshly read installed manifest plus
host-stamped install provenance. A provenance-stamped app is ineligible for the
implicit integration default even if copied input claimed `first_party`.
Distribution/launch trust remains the manifest's separate concern, preserving
existing supported installs.

## Verification

- Test first-party personal default discovery, descriptions, reads, and writes
  with no `app-capabilities.json`.
- Test explicit policy narrowing and empty-policy revocation.
- Test community, imported, forked, hidden, shared, missing, and ambiguous
  identities fail before integration transport.
- Test folder/slug alias restrictions in both directions and intersect
  conflicting alias entries.
- Test trust/policy revalidation before execution and exact account selection.
- Run contract, gateway, Web Canvas/Web Desktop, Electron Desktop, Web Mobile,
  and Native Mobile bridge regressions. Live visual evidence is N/A because the
  change has no visual surface; reviewer approval of that rationale is required.
- Update Matrix developer guidance and the public app integration guide in a
  companion `FinnaAI/matrix-os-site` PR.

## Invariants

- **Source of truth:** freshly read installed manifest trust, host-stamped
  import/fork provenance, canonicalized optional owner policy, and the live
  owner-scoped integration inventory/catalog.
- **Concurrency:** no new writes or locks; authorization is revalidated after
  discovery and before execution.
- **Orphans:** no new persistent records; install stamping uses a same-directory
  temporary manifest that is atomically renamed, and failed installs roll back.
- **Deferred:** account-specific restrictions remain ENG-252; typed bridge error
  transport is separate from this default-access correction.
