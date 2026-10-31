# Review record: on-premises and air-gap plan

Date: 2026-10-31. Implementation baseline: 231eff01cf. Tracking: [ENG-423](https://linear.app/matrix-os/issue/ENG-423).

This records reviews of the proposed plan and tasks. A resolved planning defect means the documentation was corrected; it does not mean the corresponding production behavior is implemented, tested or secure. Future code/artifact reviews remain mandatory.

## Review rounds

| Round | Reviewer/responsibility | Inputs and result |
| --- | --- | --- |
| 1 — Source and coverage | Separate runtime/client and operations/distribution investigators; parent licensing assessment | Mapped actual execution, bootstrap, service, data and client boundaries. Replaced the assumption that a local model URL or standalone web login was sufficient. See both research files and licensing.md. |
| 2 — Adversarial authority/security | Independent security reviewer, separate from plan/task authors | Identified operator/org authority ambiguity, identity collision/data migration requirements, keyless readiness and recovery gaps. Corrected contracts/spec/task requirements; no claim of a code fix. |
| 3 — Execution/dependency consistency | Task author and parent checks, with security re-review | Found legal approval unnecessarily blocking shared AGPL work, a competing security document path, conflicting EE/contract layouts and an incorrect existing updater-test path. Corrected ordering, source-of-truth paths and tests. |
| 4 — Integrated final cross-review | Runtime author reviews tasks/acceptance; operations author reviews plan/contracts; parent reads combined contracts/data ownership; independent security reviewer rechecks integrated package | No remaining P1/P2 planning gaps identified after corrections. Clarified shared OIDC verification versus EE lifecycle administration, off-installation entitlement signing and the already-selected B licensing direction. No implementation or runtime/security qualification follows from this review. |

## Substantive planning findings and disposition

| ID / priority | Planning defect | Required correction and closure evidence |
| --- | --- | --- |
| R01 / P1 | A visible local model could be mistaken for full Matrix execution | Explicit read-only spike, separate confined write-capable executor, all AI paths and real app output. spec US1; tasks T017–T030; quickstart Q02–Q05. |
| R02 / P1 | “Administrator-approved internal endpoint” could grant an org admin host-wide network authority | Installation operator owns destination/CA/egress ceiling; org may only narrow its subset. spec FR02; security-plan S1/S2; tasks T012/T074; negative cross-org policy tests. |
| R03 / P1 | Swapping identity providers could collide subjects or reassign existing data | Installation + exact issuer + subject maps immutable internal IDs; no email/raw-sub or multiuser configured-owner fallback; explicit audited migration/restore. spec FR07; tasks T045–T047/T054; quickstart Q08/Q09. |
| R04 / P1 | Keyless native readiness and process recovery could be mislabeled authenticated/resumable | Explicit credential-less readiness; separate gateway/native-process-loss matrix and uncertain-write reconciliation. tasks T003/T017/T018/T021/T025; quickstart Q02/Q04. |
| R05 / P1 | Public EE folder could imply commercial licensing rights or fully open-source status | Selected public commercial EE direction recorded separately from AGPL rights/combination clearance; no existing contributions relicensed. licensing.md; tasks T005/T057. |
| R06 / P2 | Legal decision was on the critical path for every shared-core foundation task | Shared AGPL contracts/runtime proceed independently; restricted EE notices/adapters/entitlements require legal gate. tasks dependency table T007/T008 versus T057–T060. |
| R07 / P2 | Public security.md and security-plan.md could become competing sources | Canonical security-plan.md; sensitive findings remain in private scan artifacts. tasks T006/T071–T078. |
| R08 / P2 | Proposed contract/EE layouts differed between documents | Flat contract modules and optional ee/server, ee/identity, ee/admin, ee/license layout aligned across plan/licensing/tasks. |
| R09 / P2 | Extending a nonexistent updater test could create duplicate ineffective coverage | Use actual customer-vps-update-recovery and update-manifest-trust suites. tasks T036. |
| R10 / P2 | Unavailable Daybreak access could either be called a pass or block all alternative security review | Access check records unavailable without calling Blue passed; independent review requires an explicitly approved alternative when needed. tasks T077/T078; quickstart security record. |
| R11 / P2 | EE-specific identity adapter work could precede the restricted-publication legal gate | Shared token verification/mapping first; EE adapter publication follows EE composition/license gates. tasks T046/T057/T058 and dependency table. |
| R12 / P2 | “Locally signed” could imply a private entitlement signing key on the installation | Document is stored locally but signed off-installation by the licensor; runtime contains verification public keys only. data-model.md Offline entitlement. |

The source investigations additionally distinguish internal S3 configuration from hosted EU-R2 validation, local install from offline source rebuild, single-owner login from organization authority, and binary rollback from database rollback. These are recorded requirements, not runtime qualifications.

## Security scan receipt and scope

Standard scan caa98082-a556-49bb-835d-0dd52af0b7b7 completed on packages/gateway/src/agent-config at source baseline 231eff01cf. It established no reportable finding in 15 reviewed files. It was sequential source review without independent baseline/runtime probing. Actual Hermes inference DNS/redirect/credential recipient enforcement remains deferred assurance work. Daybreak Blue did not run; account programs were unavailable. Usage measurement was unavailable.

The canonical report/findings/coverage remain outside the repository. This narrow receipt cannot establish the security of identity, collaboration, app/browser/MCP/terminal execution, full offline import, native clients or the whole codebase. Those surfaces are explicit later review/qualification tasks.

## Mechanical validation

Validated 84 unique consecutive task IDs and story labels, target paths, all local document links, no template placeholders, document lengths below 500 lines, real referenced existing test paths, Spec Kit prerequisites and whitespace. The package contains 12 Markdown documents; the branch also updates the AGENTS.md active-plan pointer. Documentation checks do not replace any production integration test. No runtime suite, real model or visual qualification is claimed for this documentation-only change.

## Remaining decisions and release blockers

Hamed selected AGPL core plus public commercial EE. Actual licensor/rightsholder and distribution strategy remain legal gates. Reference OS/model/hardware/capacity, private IdP/fleet topology and native distribution require measured implementation decisions. Runtime, device, disconnected lifecycle, independent security and artifact evidence remain open. The plan may be executable while every implementation checkbox remains open.
