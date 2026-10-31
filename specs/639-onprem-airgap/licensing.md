# Enterprise licensing and source boundary

Status: design assessment and legal questions; no terms adopted. Baseline: 231eff01cf, 2026-10-31. Root LICENSE and package metadata remain unchanged.

## PostHog's example and Matrix's starting point

PostHog's [root LICENSE](https://github.com/PostHog/posthog/blob/master/LICENSE) explicitly excludes ee/ from its MIT grant. Its [ee/LICENSE](https://github.com/PostHog/posthog/blob/master/ee/LICENSE) requires enterprise terms/license for production, permits development/testing without a subscription and restricts other rights. Its modification-ownership language is substantive and should not be copied casually.

Inference: public enterprise source can coexist with an open-source core. However, those enterprise terms are source available, not OSI open source. The [Open Source Definition](https://opensource.org/osd) requires redistribution/derived-work freedoms. A product with restricted EE cannot describe every component as fully open source.

Verified Matrix sources:

- Root LICENSE is AGPL v3 with “Matrix OS contributors” attribution.
- package.json:5 and packages/sync-client/package.json:6 declare AGPL-3.0-or-later; README.md:333 links AGPL-3.0. Resolve notice precision deliberately, not by silent version changes.
- No CLA/copyright assignment was found in the tracked contribution/license documents reviewed. Private agreements may exist; this search is not evidence that the company lacks rights.
- Third-party notices exist, e.g. desktop/src/renderer/src/assets/phosphor/LICENSE. Runtime tools and models carry independent terms.

AGPL sections 5, 7 and 13 address combined works, additional permissions and modified network use respectively (existing LICENSE:205-235 and 543-560). Relocating existing contributions to ee/, declaring a package, or using dependency injection does not establish alternative rights or resolve combined-work questions. Internal networking does not itself remove network-source considerations. A process boundary is useful engineering isolation, not an automatic legal safe harbor.

## Options for decision

| Option | Source/license posture | Commercial offering | Decision required |
| --- | --- | --- | --- |
| A — Entire implementation remains AGPL | Core and optional enterprise modules open source | Support, certified distribution, operations, training/services | Fits “fully open source”; no restrictive production-use terms |
| B — AGPL core plus restricted EE | Open-source core; source-visible enterprise modules | Licensed enterprise capabilities/support | Needs lawful distribution/combination strategy; enterprise part is not fully open source |
| C — Additional commercial grant for a defined distribution | Rights-cleared code available under AGPL and separately agreed terms | Alternative commercial license | Requires sufficient rights over every included contribution/component |

Recommendation: retain existing grants, place reusable capability/security work in core, and reserve an optional EE composition seam. Choose A or legally cleared B/C before publishing restricted enterprise implementation. This planning ticket does not select a new license or retract existing valid grants.

## Proposed capability ownership

| Shared open core | Optional EE candidates, if approved |
| --- | --- |
| Headless runtime, owner data, apps/tools and sandbox enforcement | Enterprise admin console/fleet policy composition |
| Local inference contract, safe approved-endpoint routing | Enterprise identity/directory lifecycle adapters and policy UX |
| Local authentication, authorization, audit event production/basic visibility | Compliance reports and organization-wide audit/retention workflows |
| Network policy enforcement, input/error/secret safety and security fixes | Fleet policy management and administrative approvals |
| Basic offline install/update verification, backup/export/restore | Certified offline media assembly and fleet rollout orchestration/support |
| Shared UI/client internal-origin support | Optional enterprise-specific management pages |

Core must remain usable and secure without EE. Paid entitlement is never an authorization source, a security bypass or a prerequisite for owner-data portability. Avoid a fork of kernel, gateway, shell, client stores or security patches.

## Proposed dependency direction

Pure shared contracts stay in packages/contracts/src/deployment/; owning behavior stays in existing core packages. Hosted adapters stay in packages/platform/. Proposed ee/packages/admin and ee/packages/deployment compose public core interfaces and shared brand/UI primitives; no deep imports from private internals. These EE paths are proposed, not present.

Core entrypoints do not probe or statically import ee/. An explicit EE entrypoint injects typed implementations into shared composition. Community builds must resolve, build and run with ee/ physically absent. CI checks import graph, dependency closure and artifacts; hiding UI is insufficient.

pnpm-workspace.yaml currently lists packages/*, apps/*, shell and desktop, not ee/packages/*. Any approved enterprise addition needs intentional workspace/build inclusion and a reproducible community source export/filter. Keep the frozen lockfile invariant; deleting EE sources is not a reason to bypass dependency verification.

## Offline entitlement contract

Use a bounded local document signed by the enterprise licensor, bound to installation/organization and named optional features, verified by installed public keys. No activation, telemetry, seat count or renewal callback may leave the air gap. Entitlements do not authenticate users, authorize owner data or approve network endpoints.

Clock rollback, stale revocation information, cloned installations and delayed renewal are explicit limitations. Define customer-visible grace/degraded behavior, trusted-time assumptions, key rotation and signed revocation imports before implementation. Core login/read/export/backup/restore remain available; never delete data or silently disable its protection.

## Required rights and distribution work

1. Identify legal licensor; verify employee/contractor/contributor rights and imported-code provenance for the exact candidate files. Obtain evidence of existing private agreements.
2. Decide A/B/C with rightsholders and counsel, including AGPL combination/exceptions, future contribution terms, trademarks and corresponding-source obligations.
3. Draft Matrix-specific enterprise terms only after that decision. Do not copy PostHog's company/subscription/modification-assignment language.
4. If approved, add a clear root licensing map, ee/LICENSE, file/package metadata and artifact notices. Do not alter the AGPL license text itself or imply third-party rights changed.
5. Include required corresponding source/notices on offline media and make them accessible to internal users of modified deployments.
6. Check artifact-level redistribution rights for model weights/tokenizers, native binaries, system packages and all transitive dependencies; internet availability is not permission to redistribute.
7. Test community/enterprise package contents separately. Enterprise terms never attach to owner data or community files.

Approval of this plan authorizes analysis. It does not establish contributor rights, adopt enterprise terms or authorize a production license migration.
