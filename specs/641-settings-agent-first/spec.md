# Agent-first Settings navigation

Ticket: [ENG-433](https://linear.app/matrix-os/issue/ENG-433/make-agent-sign-in-the-first-settings-destination).

## Goal and behavior

Opening Settings should make agent sign-in immediately discoverable. Place
Agents & providers first and select it on a normal opening. Put the Integrations
group next (Connect Apps first), followed by Appearance/account, Organization,
and the remaining Machine sections. Preserve explicit section links, onboarding
locks, billing access checks, and each surface's existing capabilities.

## Surfaces and acceptance

- Web Desktop, Web Canvas, Electron Desktop: shared desktop Settings sidebar
  and normal Settings launch open Agents & providers; Connect Apps still opens
  its integration section. The web Settings dialog follows the same priority.
- Web Mobile: existing web Settings dialog opens Agents & providers first.
- Native Mobile: no equivalent agent sign-in settings page exists today; adding
  one is outside this sidebar reorder. Record this limitation for reviewer approval.
- Verify production component navigation order, initial selection, launcher
  routing, explicit deep links, and billing/onboarding restrictions with focused
  renderer tests. Record regression failures before implementation.
- Collect separate live preview screenshots and recordings for every affected
  surface before review readiness; local captures only support development.

## Scope and risks

No provider auth, credential storage, gateway, or database changes. Keep existing
routes and permissions. Large existing entrypoints receive routing-default-only
edits; extract Settings entry actions into a focused navigation module before
adding any further behavior there.

Recommend product/design review of the new priority. The requester approved the
priority in this chat; this recommendation adds no approval gate.

## Documentation and review

- Include a companion docs PR in FinnaAI/matrix-os-site/content/docs describing
  Settings opening directly to Agents & providers.
- Link the verified ENG ticket, implementation PR, exact tested head/build,
  per-surface evidence, and Slack #tech evidence permalink before readiness.

## CI failure repairs

- The agent-first default exposed a billing navigation fixture that bypassed the
  ApiClient contract and omitted `forRuntime`. The fixture now supports scoped
  clients, and the test opens Billing from the actual default Settings view.
- The Host build attempted `pnpm rebuild node-pty` at the root even though
  `node-pty` belongs to the gateway workspace. A real-pnpm regression fixture
  proves the old command exits successfully without running the dependency
  lifecycle. Rebuild in the gateway workspace before gateway import checks.
- Native compilation and ABI qualification remain the real Linux preview build's
  responsibility; the local regression only verifies workspace lifecycle scope.
