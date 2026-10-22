# Public app sites: release and validation

The code does not automatically deploy infrastructure. Release platform and host bundles through their normal reviewed pipelines. Use a scoped disposable customer test runtime for live validation; preview/operator machines cannot publish.

## Prerequisites

- A private R2 asset bucket with its own credentials, separate from owner sync and host bundles. Configure platform `R2_SITES_BUCKET`, `R2_SITES_ACCESS_KEY_ID`, `R2_SITES_SECRET_ACCESS_KEY`, and its account or endpoint. Do not enable public R2 access.
- A separately generated `SITES_EDGE_SECRET` of at least 32 characters, stored as secrets in both platform and Worker. Owner tokens never enter the public Worker.
- The sites migration applied through the existing platform migration runner. It has its own scope and does not change the core migration fingerprint.
- A reviewed HTTPS platform origin in the Worker's `SITES_PLATFORM_ORIGIN`. It must be a fixed operator-controlled URL.
- Deploy `packages/edge-router/wrangler.sites.toml` with the existing Cloudflare account tooling. It attaches the Worker as the origin for the owner's newly purchased `matrix.page`, including Cloudflare DNS/TLS. Disable workers.dev and preview URLs so the fixed-origin sandbox cannot be bypassed.
- The already provisioned `MATRIX_SYNC_RUNTIME_TOKEN` authorizes owner publication delegation and signs scoped submission capabilities. It binds the machine ID, runtime slot and rotation epoch. Sites never accept the legacy handle-only token, and hosts without the scoped credential fail closed.

Cloudflare documents this routing mode in [Worker Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/). Customer-owned domains require a later verified-hostname design.

## Domain homepage

The Worker redirects GET/HEAD requests for `/` to `https://matrix-os.com` with status 302 and no query forwarding. Before app hosting ships, a Cloudflare Single Redirect provides the same behavior: `(http.host eq "matrix.page" and http.request.uri.path eq "/" and http.request.method in {"GET" "HEAD"})`, static destination `https://matrix-os.com`, status 302, preserve query disabled. Keep the match root-only when attaching the Worker; never redirect every path.

Cloudflare requires proxied DNS for redirects. A redirect-only apex can use a proxied A record pointing to `192.0.2.1`, as described in [Cloudflare's domain redirect guide](https://developers.cloudflare.com/fundamentals/manage-domains/redirect-domain/). Reconcile that placeholder record during the reviewed Worker Custom Domain attachment. Verify HTTPS root redirects, incoming queries are dropped, and a sample app path does not redirect to the homepage.

## Live acceptance

1. Install the exact reviewed host bundle in a disposable customer runtime and verify gateway/owner Postgres readiness.
2. Build an information-only React/Vite launch guide using relative assets, support guidance, public links and any discount code. No forms or publishing declaration are required. Use a separate app with explicitly declared fields to validate optional visitor submissions.
3. Review/publish from Web Canvas, then verify the same management actions in Web Desktop and Electron Desktop. Check Web Mobile usability. Native Mobile has no owner publication management in v1.
4. Visit both permanent ID and friendly URL anonymously. Confirm module assets load in the opaque frame and private bridges/storage are unavailable.
5. For the separate form-enabled app, submit a response, verify exact owner readback, retry the same key, export the page and delete it. Verify another owner/collaborator cannot read or mutate it. Confirm the launch guide renders without forms.
6. Publish an update and restore the prior version. Check the URL and saved records remain stable. Take the owner runtime offline: page still loads, form returns unavailable.
7. Unpublish and verify ID, every historical alias, frame, version asset and form URLs fail. Republish with the same ID.
8. Request deletion of the disposable owner account only in an explicitly authorized deletion test: public access must stop and all owner-prefixed assets/configuration must be erased. Delete only a dedicated test account, never an existing user account.

## Monitoring and mitigation

The release owner watches platform and gateway logs containing `[sites]` during rollout and for 30 minutes after acceptance. Healthy signals are successful owner publication, anonymous page/module load, a coarse form acknowledgement, and one exact owner database record per idempotency key. Watch site-route 5xx/429 responses, artifact rejection, storage cleanup failures, form persistence failures and account-erasure retries.

Unexpected private data access, a post-revoke new admission, or repeat form persistence failures blocks rollout. Unpublish the affected app, disable the Worker routing if exposure is wider, and roll back the runtime/platform release through existing release channels. Keep the additive migration and dedicated bucket private; do not drop owner submissions or version objects as a rollback shortcut.

The launch fixture in `tests/fixtures/apps/public-launch` exercises the public bridge. Full-path tests use separate platform and owner PostgreSQL-compatible fixtures; `tests/platform/sites-postgres.test.ts` uses independent real PostgreSQL sessions when `MATRIX_TEST_POSTGRES_URL` names a disposable test database. Local browser evidence substitutes a localhost origin for the fixed production sandbox origin and is not Cloudflare deployment evidence.
