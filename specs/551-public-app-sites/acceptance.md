# Implementation evidence

Implementation branch: `codex/public-app-sites`, based on freshly fetched `main` commit `cac85957026fce49fd4f6f4aa404faf9e129644e`; refreshed again before PR preparation with no new main commits. Public origin: `https://matrix.page`.

## Completed checks

- 198 focused tests across 31 files passed on the final Node 24 source snapshot, including information-only deployment without a publishing declaration, homepage routing, safe outbound/fragment links, checked React/Vite launch deployment, anonymous RSVP acknowledgement and exact owner readback, durable deduplication, owner export/delete, update/rollback, ID/alias/version-asset/form revocation and cross-owner isolation.
- Independent real PostgreSQL sessions verified publication/revocation serialization and account-deletion admission ordering against a disposable local database.
- The local browser submitted a name, email and guest count through the actual opaque public-frame bridge; the saved owner record matched exactly. Public fixture worked at 375 and 1280 px. Local origin substitution makes this browser proof, not production Cloudflare evidence.
- A separate information-only React/Vite fixture rendered without forms. HTTPS links opened separately, the HTTP destination confirmed its opener was null, and repeated section links stayed within the app frame. Temporary servers, fixtures and agent-created guide tabs were cleaned up.
- Cloudflare's root-only redirect is active. TLS-validated HTTPS requests to the public DNS answer returned 302 to `https://matrix-os.com/`, including a query-bearing request whose query was discarded. The local system/browser resolver initially retained a negative DNS result. App hosting infrastructure remains awaiting release.
- Native Mobile's shared contract import regression was reproduced and fixed with the existing package-import alias pattern and a dedicated regression test. The full Native Mobile run exercised 119 suites; its one SharedScreen timeout passed all 27 tests when rerun in isolation.
- Platform schema characterization, unchanged core migration fingerprint and independently tracked WhatsApp startup checks passed after updating the additive schema baseline. The public-sites migration lives outside core fingerprint inputs.
- Canonical repository typecheck, separate Web shell typecheck and shared publishing UI lint passed. Focused gateway/platform typechecks passed after review fixes.
- Thirteen specialist review passes and seven independent validators resolved six defects: read admission, ambiguous commit cleanup, Electron status parity, publication concurrency, excessive history projection and deletion pagination/export recovery. No residual actionable review work.
- Automated review follow-up resolved recovery remapping, stable microsecond/ID pagination, stale export downloads and missing-edge-secret access. New tests failed before each fix; independent review found and then cleared an additional stale-recovery compensation race. Existing recovery regressions passed (27), and final Native Mobile shared contract import passed. Canonical typecheck plus final Web shell/platform typechecks passed.
- Production Web shell build passed with the same nonsecret test configuration as CI. Three additional parent-bridge logging regressions passed (coarse error categories only); affected export and real React/Vite fixture checks also passed.
- The final shared publishing UI audit scored 100 with no diagnostics. All 18 focused UI tests, lint and Electron renderer types passed; independent review cleared runtime-client replacement, action lifecycle and cached export privacy after the compiler refactor. Deterministic dates are labeled UTC.
- A broad remaining-repository run passed 2,465 files. Fresh isolated reruns cleared 22 failures; four failures remain in three unchanged local-baseline files (terminal paste cleanup, OpenClaw repair-cache timeout and desktop DMG bitmap comparison). The complete repository suite is not claimed green; current-head CI remains a separate gate.
- Public docs companion [matrix-os-site #218](https://github.com/FinnaAI/matrix-os-site/pull/218): 281 tests passed; rendered at 375, 768 and 1280 px without page overflow. Marked awaiting release.

## Explicit limits and release boundary

Scoped Chat publishing is deferred in [ENG-233](https://linear.app/matrix-os/issue/ENG-233/featsites-allow-scoped-chat-runs-to-manage-public-apps); genuine owner REST clients and the shared Publish app controls are supported. Native Mobile has preview-only app support and no owner publication management. Version history is capped at 50 deployments; exports are one bounded page at a time.

Real Web Canvas, Web Desktop and Electron Desktop owner flows and live Cloudflare DNS/TLS require the exact reviewed release and configured private asset bucket, edge secret and customer test runtime. Follow [operations.md](./operations.md); infrastructure and fleet rollout are not performed by the implementation PR.
