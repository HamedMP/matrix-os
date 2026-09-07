# MAT-519 billing presentation evidence

Captured September 7, 2026 from the billing fix and trial-state follow-up in PR #1579. Every account, allowance, subscription, price and location shown here comes from synthetic fixtures. No production account was accessed or modified.

## Web Canvas, Web Desktop and Web Mobile

Run a clean local shell with `E2E_TEST_BYPASS=1 NEXT_PUBLIC_E2E_TEST_BYPASS=1` and the repository's CI-safe Clerk publishable key. Build workspace brand dependencies before starting the shell; discard stale `.next/dev` output when switching those dependencies. Run `PLAYWRIGHT_PORT=3119 pnpm --dir shell exec playwright test --grep 'billing management' --reporter=html` against that local server. All six scenarios passed. Images were copied without alteration from the report attachments.

| Surface | Team access without subscription/customer | Paid subscription under team override |
| --- | --- | --- |
| Web Canvas | [Team access](billing-team-access-web-canvas.png) | [Paid + override](billing-override-paid-web-canvas.png) |
| Web Desktop | [Team access](billing-team-access-web-desktop.png) | [Paid + override](billing-override-paid-web-desktop.png) |
| Web Mobile | [Team access](billing-team-access-web-mobile.png) | [Paid + override](billing-override-paid-web-mobile.png) |

## Electron Desktop

The two Electron images show the actual `SettingsView` Billing section rendered in Electron, using a temporary `OPERATOR_USER_DATA_DIR`, the production feature components/styles, and the same synthetic billing fixtures. A temporary Vite test module mounted the focused section and supplied its connection-store API response; the module and temporary profile were removed after capture. This validates the component rendering, not production authentication or portal navigation. Local Vite reported font asset serving warnings, so this is not a font-fidelity baseline.

- [Team access](billing-team-access-electron-desktop.png)
- [Paid subscription under team override](billing-override-paid-electron-desktop.png)

## Remaining evidence

Native Mobile device screenshots remain required. This host has no Xcode installation or `simctl`; Web Mobile and Electron evidence do not substitute for Native Mobile. The focused Native Mobile billing tests pass, but full native Jest has import/setup failures in other suites and full mobile typecheck reports existing component-type failures. No native device or full-suite pass is claimed.
