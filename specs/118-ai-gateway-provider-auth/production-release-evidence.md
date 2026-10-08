# Funded Relay production release evidence

The Relay workflow accepts production only from `refs/heads/main` and only with
reviewed, exact-source evidence. This replaces an unconditional Preview-only
rejection with a fail-closed correctness gate. It does not declare any current
deployment production-ready, verify upstream prices, or replace the live GA
acceptance in [quickstart.md](./quickstart.md). Health and credit display are
separate from a completed, correctly metered inference.

## Review authority and prerequisite configuration

The existing PR, exact-head CI and Greptile 5/5 requirements govern the workflow
change. A repository administrator sets these production environment variables
only after reviewing the actual acceptance packet:

- `MATRIX_FUNDED_AI_ACCEPTANCE_RUN_ID`: completed, successful same-repository run of
  `.github/workflows/funded-ai-acceptance-evidence.yml` on the exact deployed main SHA.
- `MATRIX_FUNDED_AI_ACCEPTANCE_RECEIPT_SHA256`: SHA-256 of the exact `receipt.json`
  bytes in that run's `funded-ai-production-acceptance` artifact.

These pins are environment configuration, not dispatch inputs. The environment
name alone provides no reviewer protection. No new required-reviewer policy is
introduced. The administrator and operator remain responsible for checking
that the evidence describes real acceptance; structurally valid JSON or a
successful import is not that evidence. Do not use an importer receipt as proof
of metering. Raw private operator receipts remain in the private support system.
The loader requires GitHub run `status=completed` and `conclusion=success`
before requesting its artifacts; a queued, in-progress or missing status fails
closed even if the response contains a successful conclusion.

The production Relay must be a dedicated `matrix-ai-relay` or
`matrix-ai-relay-production` service, using its dedicated service account and the
canonical `https://app.matrix-os.com` Platform origin. Its reviewed Cloudflare
Anthropic gateway must not be a Preview, staging, canary or development gateway.
All existing resource caps, `usage` reservation mode, explicit price review
windows and paid-probe limits remain applicable.

The dedicated service must already exist with a reviewed safe baseline before
the workflow's first candidate deployment. Cloud SDK explicitly rejects
`--no-traffic` when creating a new service; this workflow fails before building
if that baseline is missing. Bootstrap is a separate operator prerequisite,
not an enabled first Relay revision. A supported baseline uses the reviewed
digest-pinned Relay image but overrides its command to `node`, with `-e` and
this inert HTTP program as arguments:

```javascript
require('node:http').createServer((request, response) => {
  const healthy = request.url === '/health';
  response.writeHead(healthy ? 200 : 404, { 'content-type': 'application/json' });
  response.end(healthy ? '{"ok":true}' : '{}');
}).listen(Number(process.env.PORT || 8080), '0.0.0.0');
```

It mounts no secrets and carries no funded configuration; only process health
is available. Preserve the workflow's bounded resources and verify 404 for
inference/readiness routes. An approved equivalent inert baseline is also
valid. The candidate deployment explicitly clears inherited command/arguments
to use the pinned image entrypoint, then independently checks that the actual
candidate revision receives zero percent default traffic. Do not remove
`--no-traffic` to make new-service deployment succeed.

Production selects only `cloudflare-ai-gateway-token-production` and
`cloudflare-workers-ai-token-production` for upstream credentials, with no
fallback to Preview. Central `ai-relay-control-token` and
`ai-relay-metadata-secret` retain their supported identifiers. The packet pins
numeric versions of all four secrets; the workflow checks each version's
existence and the Relay service account's accessor binding without reading
values. Provisioning/IAM and the actual Platform control-token version/topology
must be checked separately before candidate acceptance. Never copy a customer's
runtime token or mount an upstream credential on a customer VPS. Updating a
secret version or pricing interval requires new matching acceptance; production
does not resolve these mounts through `latest`. Staging retains its prior secret
IDs and `latest` selection.

These fixed Secret Manager identifiers are this deployment contract, not a
Cloudflare requirement to mint fresh tokens. An existing authorized credential
may be explicitly approved for reuse after validity, permissions, account and
request restrictions are checked. Separate tokens in one Cloudflare account
do not provide per-gateway authorization isolation; they support independent
rotation and revocation. See [Cloudflare authentication](https://developers.cloudflare.com/ai-gateway/configuration/authentication/).
Funding-summary reads call Platform only; a successful credit display does not
establish upstream inference readiness or GA acceptance.

## Metadata packet contract

Create a ZIP containing `receipt.json` and the referenced, public-safe metadata
files. Files must have flat lowercase `.json` or `.md` names; no directories,
symlinks, duplicate paths, encrypted entries or unreferenced files are accepted.
Limits are 32 files, 128 KiB per file and 2 MiB compressed/expanded total. JSON
duplicate fields are rejected. Evidence files should contain measured results,
immutable provenance and private-evidence references, without credentials,
customer identifiers, IPs, prompts, completions or other customer data.

The receipt has exactly these fields:

```json
{
  "schemaVersion": 1,
  "sourceSha": "<full exact main SHA>",
  "stage": "preview",
  "reviewedAt": "<canonical UTC ISO timestamp with milliseconds>",
  "validThrough": "<canonical UTC ISO timestamp with milliseconds>",
  "configuration": {
    "projectId": "<production project>",
    "region": "<production region>",
    "relayService": "matrix-ai-relay",
    "relayServiceAccount": "<dedicated account in production project>",
    "platformOrigin": "https://app.matrix-os.com",
    "cloudflareGatewayUrl": "<reviewed official production Anthropic gateway URL>",
    "secretVersions": {
      "gatewayToken": "<numeric version>",
      "workersToken": "<numeric version>",
      "controlToken": "<numeric version>",
      "metadataSecret": "<numeric version>"
    },
    "pricing": {
      "MATRIX_FUNDED_SONNET_PRICING_REVIEW_VERSION": "anthropic-2026-08-31-standard",
      "MATRIX_FUNDED_SONNET_PRICING_REVIEWED_AT": "<review timestamp>",
      "MATRIX_FUNDED_SONNET_PRICING_VALID_THROUGH": "<expiry timestamp>",
      "MATRIX_FUNDED_GLM_PRICING_REVIEW_VERSION": "cloudflare-2026-09-10-glm-flash",
      "MATRIX_FUNDED_GLM_PRICING_REVIEWED_AT": "<review timestamp>",
      "MATRIX_FUNDED_GLM_PRICING_VALID_THROUGH": "<expiry timestamp>",
      "MATRIX_JEV_PRICING_REVIEW_VERSION": "typesafe-jev-input-2026-09",
      "MATRIX_JEV_PRICING_REVIEWED_AT": "<review timestamp>",
      "MATRIX_JEV_PRICING_VALID_THROUGH": "<expiry timestamp>"
    }
  },
  "checks": {
    "metering": { "status": "passed", "path": "metering.json", "sha256": "<hash of exact evidence file bytes>" }
  }
}
```

The example is incomplete and intentionally cannot pass. `checks` must contain
exactly `metering`, `canary_metrics`, `policy_health`, `spend_fuse`, `kill_switch`,
`auth_leakage`, `surface_parity`, `rollback`, `review_gates` and `public_docs`.
Each entry has exactly `status`, `path` and `sha256`; `passed` is allowed only
after actual acceptance. Every referenced byte hash is checked. Review validity
must be current and at most seven days. Source must equal the import and deploy
run SHA; previous-head receipts cannot be carried forward. Sonnet/GLM price
reviews must be current, at most 31 days; Jev at most 90 days. Versions remain
immutable and timestamps are not renewed relative to startup.

## Canonical Platform control-plane staging

Before production candidate acceptance, deploy the reviewed Platform control
plane at the canonical origin with `MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED=true`
and `MATRIX_FUNDED_AI_RUNTIME_ENABLED=false`. The workflow permits this staged
combination, while requiring bounded probe budgets and a reviewed HTTPS Relay
origin whenever control is enabled. Add-on checkout stays disabled. Read back
actual default traffic, source and mounted control-token version; a tagged
Platform Preview is not a production substitute.

Deploy the isolated Relay candidate before its production-chain acceptance,
then bind this control-only Platform's reviewed Relay origin to that exact
tagged **production** candidate. Platform's paid model probes use its configured
Relay origin; leaving them on the inert default baseline cannot establish
model readiness. The Platform origin itself remains canonical. Verify that
the reviewed operator canary is the only active funded caller using this
temporary binding; keep customer-host migration deferred. Disabling runtime
provisioning does not revoke existing machines' funded credentials or policy.
If existing customer callers already depend on this canonical funded route,
defer this sequence until a separately reviewed isolation/window is established.
After promotion, rebind the Platform to the canonical production Relay origin
and verify fresh readiness and actual routing before enabling provisioning.

Existing hosts remain unchanged and new runtime provisioning stays disabled
through Relay acceptance. Enable runtime provisioning only after the accepted
Relay is promoted and verified, then apply the separately guarded existing-host
migration. Preserve persistent probe counters throughout; the control-only
stage does not justify resetting budgets or renewing price timestamps.

## Import and two-stage release

1. Complete the governing Preview/GA checks on a disposable/operator-owned
   canary. Include canonical usage, reservation/request locator, captured price,
   exactly-once settlement and matching ledger delta; retain unknown liabilities
   when canonical usage is absent. Include actual canary spend/error/TTFT,
   policy/health, exercised spend fuse and kill switch, auth/leakage, applicable
   Web Canvas/Web Desktop/Electron Desktop parity, PR gates, merged public docs
   and rollback evidence. Customer Chat turns are not the paid acceptance probe.
2. Package the existing metadata evidence, hashing each referenced file and the
   final receipt bytes. Upload that ZIP as a same-repository release asset.
   Dispatch **Funded AI Acceptance Evidence** on main with `release_asset_id`
   and `archive_sha256`. The importer downloads only that repository's asset,
   checks the archive pin/bounds/source/schema, executes no content, and retains
   the artifact for seven days. It grants no deployment permission and uses no
   cloud secret. It prints no raw evidence. Review its artifact and set the
   administrator-managed production run/receipt pins.
3. Dispatch **AI Relay Cloud Run**, production, `promote=false`, with the
   `stage=preview` packet. Configuration must exactly match the packet; separate
   production secrets and explicit price attestations are required. The image is
   digest-pinned, labelled with source SHA, tagged `candidate`, and kept off
   default traffic. Record actual candidate image/revision and actual Platform
   provenance; latest-ready metadata is insufficient.
4. Perform production-chain acceptance on that exact candidate using only the
   reviewed operator canary and bounded probe budget. Import a new packet with
   `stage=production`, all the actual GA evidence, and one additional field:
   `"candidate": {"revision":"<exact candidate revision>","image":"<full Artifact Registry image@sha256:digest>"}`.
   Review and update the production run/receipt pins.
5. Dispatch production `promote=true` from that same SHA. This path **reuses**
   the existing candidate rather than rebuilding/deploying. It independently
   reads Cloud Run's candidate tag/revision and checks the exact digest, source
   label, service account, Ready condition, funded configuration, price reviews
   and every numeric secret binding against the receipt. It also enforces the
   workflow's admission limits/betas, CPU 1, memory 512 MiB, concurrency 32,
   timeout 900 seconds and 0–3 instances, rejecting unknown environment entries.
   Command/argument overrides and mounted volumes are rejected so an inherited
   inert bootstrap or a changed executable cannot masquerade as that image.
   A moved tag or changed
   environment fails closed. It rechecks immediately before routing the exact
   accepted revision to 100% traffic. Process-health/legacy-route smoke does not
   substitute for the production acceptance packet.

The release workflow concurrency key serializes its own candidate operations;
independent operator/cloud writers require coordination during acceptance and
promotion. On missing, expired, incompatible or unverifiable evidence, leave
production traffic unchanged. Rollback and customer runtime migration remain
separate reviewed operations that preserve outstanding reservations and owner
data. The required public documentation update ships in the separate
`FinnaAI/matrix-os-site` PR before the `public_docs` gate is marked passed.
