# Community App Store preview

The store prepares a private owner-app copy, requires separate AI-disclosure and source-upload consent, then accepts staff review. Approval signs immutable full source; each installer builds it on their own VPS. Owner app data stays in their Postgres namespace. The production feature flag defaults off.

- Architecture, configuration, authority and cleanup: [implementation alignment](../../specs/631-app-store-publishing/implementation.md).
- Routes/auth: [platform contract](../../specs/631-app-store-publishing/contracts/platform-api.md), [gateway contract](../../specs/631-app-store-publishing/contracts/gateway-api.md), [bridge policy](../../specs/631-app-store-publishing/contracts/bridge-policy.md).
- Isolation: dedicated non-root build namespace, no network/owner-home/secrets, brokered pinned dependencies, pnpm10.33.4, bounded output and process-tree teardown. Host bundles include the integrity-verified tool and reversible pnpm activation; Node and other global packages stay intact. A legacy unsafe runtime mount root is sealed only after artifact verification by the fixed privileged prerequisite helper.
- Recovery: durable local jobs and publication journals reconcile source, grants and provenance; edited owner source is never overwritten. Metrics follow successful publication and retry independently.
- Review: approved, delisted and suspended listings remain reachable through reviewer-only navigation. Prior installers receive a coarse removal notice.
- Qualification: use a channel-none exact-PR bundle and separate staging authority/storage/signing keys. Capture each affected running surface, disclose fixtures and follow the repository review gate. Never enable or deploy to production to collect evidence.

Tracking: [ENG-322](https://linear.app/matrix-os/issue/ENG-322/add-reviewed-community-app-publishing-to-matrix-gallery), [native stack #2736](https://github.com/HamedMP/matrix-os/pull/2734), [public guide PR](https://github.com/FinnaAI/matrix-os-site/pull/272).
