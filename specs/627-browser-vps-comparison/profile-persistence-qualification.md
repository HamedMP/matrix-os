# Shared Browser profile qualification

Tracking: [ENG-332](https://linear.app/matrix-os/issue/ENG-332). This adds qualification of the existing shared profile, not a new credential store or a local-to-cloud import feature.

## Contract and executable lane

`tests/integration/shared-browser-profile.integration.ts` uses the production shared CDP driver and broker against an owned temporary Chrome profile. An exact-origin local fixture acts as a nonforwarding HTTP proxy. Opaque synthetic session cookies never enter snapshots or evidence; page observations contain booleans and an independent effect counter.

Run with the installed Playwright Chromium or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to a supported executable, never an existing browser's debugging endpoint/profile:

```sh
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/shared-browser-profile.integration.ts --maxWorkers=1 --no-file-parallelism
```

The required general E2E job installs the known browser and invokes this lane separately. It must fail on missing executable, zero tests, skipped tests, or a failed result. No model account or external website is involved.

## Observable acceptance

| Transition | Expected result |
|---|---|
| Empty initial profile | Actual protected HTTP route rejects access; storage markers absent |
| Explicit synthetic owner grant, then fresh agent tab | Protected HTTP route accepts the browser's HttpOnly cookie; localStorage/IndexedDB present; cookie value inaccessible to page script; tab-only sessionStorage not inherited |
| Detach and new authorized broker/driver | Same persistent website state; old capability/reference rejected |
| Clean Chrome close/restart with same profile and fixture origin | HTTP authentication and persistent storage remain available |
| Separate empty profile while original server session is still valid | HTTP access denied and persistent storage absent |
| Server session expires or owner logs out | HTTP access denied despite previously stored browser state |
| Disconnect after a confirmed effect, observe through new run | Independent effect counter remains one; no automatic mutation replay |

Missing configuration is not a test skip. A named fresh-profile-on-restart fault must fail the persistence assertion; setup failures do not count as red evidence. Socket/server/child-process/profile cleanup is bounded, explicit and restricted to owned resources.

## Evidence and limits

Local macOS Chrome156.0.8078.80 passed the lane on 6 November 2026, with a named failing fault replay followed by restored green. Linux CI is a separate required result. Fixture-only CDP port/DNS/proxy seams leave production SSRF policy unchanged and do not establish production DNS pinning.

This proves synthetic website state on the tested browser and code path. It does not establish real website OAuth/MFA/passkeys/keyring behavior, arbitrary sessionStorage restoration, crash/power-loss durability, cross-machine migration, platform owner isolation, Linux systemd updates, KasmVNC/Web/Electron visual behavior, model tool selection, or exactly-once effects after a lost acknowledgement. Real account and exact-host acceptance require an approved runtime and owner participation. Never clear an owner profile to repair qualification.

Public behavior/limitations are documented separately in existing matrix-os-site Browser guide PR #288. No deployment or merge is authorized by this qualification.
