# Provider setup recovery

Status: active

Implement the user-approved recovery on PR #1502. Do not merge or change production channels.

## U1 — Compact shared settings

Goal: Matrix AI is visible first; installed agents use compact expandable rows like the supplied T3 reference. Connection actions precede customization.
Files: packages/ui/src/agents-providers/{AgentsProvidersView,HarnessRail,HarnessEditor,GatewayPanel}.tsx, agents-providers.css; new focused UI presentation tests.
Approach: preserve canonical snapshot/actions and shared adapters; collapse customization under Advanced; show one actionable status; no simulated readiness or invented balances. Keep gateway visible without a selected agent or source. Show operator-owned values as read-only text, not dead form controls.
Execution note: tests first. Existing patterns: agents-providers feature and tests/ui/agents-providers-view.test.tsx.
Verification: gateway-first order, expandable rows, no blank icons, absent policy/source explanation, advanced collapsed, route/account behavior retained, read-only/error tests.

## U2 — Guided agent setup

Goal: Add agent leads through choosing agent, visible install/login, explicit funding/model choice, and refresh/verification. Never report a successful operation before server completion.
Files: AddHarnessDialog.tsx, AccountsPanel.tsx, types.ts, provider-settings-controller.ts; shell/desktop provider adapters only if required; new focused setup tests. Do not edit U1 files; coordinate added props with U1.
Approach: use existing canonical Terminal/account-attempt APIs; inspect runtime contracts before offering capabilities. Hide unsupported account mutations rather than imply concurrent profiles work. Installed agents discovered automatically.
Execution note: tests first. Patterns: FeatureDialog, existing controller and adapter tests.
Verification: missing installation starts visible supported Terminal flow; auth pending/retry/error; ready source selection; explicit unsupported specialized flow; failed add keeps dialog/drafts.

## U3 — Preview gateway and integration

Goal: pr-1502 receives bounded Matrix-funded access from the existing staging relay/control plane, with no central credentials on the VPS, and one real Chat turn verifies usage.
Files: scoped preview provisioning/configuration helpers and tests as needed; public-safe operational documentation.
Approach: inspect supported machine registration/provisioning APIs and current runtime truth; use exact verified preview identity. Maintain staging isolation, atomic policy/ledger operations, existing small test allowance, secret-safe transport. Stop for new financial/identity authority if required.
Execution note: test-first for code changes; live reads before scoped mutations.
Verification: policy and relay health, canonical V3 and Chat catalog, successful bounded real Chat, ledger reconciliation. Then publish register-only exact bundle and verify Web Canvas, Web Desktop, Electron Desktop where available.

## Delivery

Run focused suites and typecheck, review the combined diff, publish via the existing Graphite stack without merging. Record any blocked validation explicitly. Public documentation requires a separate FinnaAI/matrix-os-site PR; do not copy private incident details into this public repository.

## Validation checkpoint

U1 and U2 are implemented locally. The final combined shared UI, controller,
transport, Electron adapter, generic model parser, route mutation, and funded
authentication suites pass 146 tests across 11 files. Web, Electron, and platform
type-checking pass. Focused tests include failed mutation retention, expired and
failed login handling, stable funding selection across refresh, computer-switch
safety, unsupported profile actions, gateway route repair, and visible setup.
Hermes/OpenClaw managed routing is explicitly blocked in the shared eligibility
predicate, settings, and server mutations until the system runtime can apply
the funding source. Browser inspection of the actual shared component confirms
gateway-first layout and guided Pi connection; the local harness uses labeled
synthetic data and does not substitute for integrated live surface verification.

U3 remains incomplete: staging policy/credit summary succeeds, but the first
bounded relay request returns an authentication error without any usage charge.
The control-token whitespace mismatch is fixed locally with two regressions;
37 platform/relay-security tests pass. The staging platform still needs the fix
deployed before the inference check is repeated.
Preview host configuration readability must be restored through an authorized
operator connection before integrated Chat and three-surface verification.
Full review, fresh CI/review gates, exact-bundle publication, and the separate
public documentation PR remain pending. No merge is authorized.
