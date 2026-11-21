---
status: active
issue: ENG-355
---
# Gmail OAuth verification readiness

Ticket: https://linear.app/matrix-os/issue/ENG-355/prepare-gmail-oauth-verification-and-casa-evidence
Requester: Hamed Mohammadpour. Authorized: finish Matrix-side preparation, then seek assessor quotes. Scope includes a reviewed staff pilot, truthful disclosures and evidence, and a prepared Google submission. Assessor contact/payment and broad public Gmail access remain later stages.

## Requirements

- Reuse PR2273 implementation; preserve the original branch and all unrelated work.
- Port the implementation onto fetched origin/main in reviewable native GitHub stack layers under the repository size limits. Share ENG-355; keep Google client IDs and staff membership private.
- Preserve exact owner/account grants, approvals, transport identity, no automatic write retry, encrypted credentials, consent proof, eligibility and feature-off revocation.
- Qualify Matrix and Pipedream choices on the exact candidate across Web Canvas, Web Desktop, Electron Desktop, Web Mobile and Native Mobile. Capture live screenshots and recordings separately; a local fixture is insufficient.
- Finish public Google-data disclosures only where actual behavior and enforceable provider controls support them. Document any remaining policy decision honestly.
- Prepare scope justification, actual OAuth/function demonstration video, data-flow inventory, deletion/retention evidence and CASA control evidence.
- Keep Matrix staff access restricted even when Google's publishing status eventually changes. OAuth production status and public Matrix rollout are separate controls.
- Merge/deploy only when ticket, current review/CI and live-evidence gates pass. User personally completes consent or other required authentication/attestation handoffs.

## Units

### U1 — Current readiness and submission packet (root)
Goal: identify current blockers and maintain private evidence with dated provenance.
Files: this public-safe plan; private evidence directory outside the repository; existing PR/ticket metadata.
Approach: inspect Google UI read-only, cloud secret/config metadata without plaintext, prior CI/review, and required official verification fields. Prepare final reviewable submission before any final publishing/attestation action.
Verification: sourced process, exact current configurations, clear completed/pending evidence; no misleading live claims.

### U2 — Backend and platform adaptation (worker, isolated worktree)
Goal: bring the existing direct Gmail backend forward without bypassing current integration authority.
Files: shared Gmail choice contract/schema and tests first; native-gmail gateway modules, platform persistence/consent/deletion/routing/startup, deployment wiring and associated focused tests. Do not edit UI or agent tool files. Publish the initial contract commit to the client worker as a dependency before later units.
Approach: inspect PR2273 diff against its merge base and current main; reuse the existing implementation, write regression tests first for changed interactions. Split into contracts/backend and platform/deploy layers with native gh-stack; root publishes after review.
Verification: focused direct Gmail and current integration authority tests, type checks, build and production loader smoke. No real mailbox writes.

### U3 — Client and agent choice adaptation (worker, isolated worktree)
Goal: preserve explicit Matrix/Pipedream choice across current clients and owner tools.
Files: packages/ui integrations choice, shell and Electron integration screens/stores/request helpers, Native Mobile integration screens/requests/queries, kernel integration handlers/IPC/options, integrations-MCP and related tests.
Approach: inspect client/agent deltas while U2 prepares the contract commit, merge that reviewed dependency before editing, then port only PR2273 client/agent deltas onto current main. Preserve newer Connect Apps and integration-write behavior. TDD for changed boundaries. Do not edit U2 backend/platform or U4 public site.
Verification: per-surface tests and types; built kernel/MCP; scoped read permission lists unchanged; actual live captures remain a separate gate.

### U4 — Public disclosures and provider policy evidence (worker, private site worktree)
Goal: prepare truthful Google-data privacy/help content and identify runtime enforcement gaps.
Files: private matrix-os-site privacy/help/Gmail guide and tests; private provider-policy evidence note. No Matrix backend edits.
Approach: inspect current site and PR197, actual Matrix data paths, Google policy; draft no-training/transfers/retention/deletion disclosures only supported by implementation and verified provider settings/contracts. Flag unsupported claims and propose bounded enforcement rather than inventing assurances. Separate site PR uses ENG-355.
Verification: docs/content tests, MDX/rendered live preview evidence; no unverified certification or production-availability claims.

### U5 — Integration, qualification and rollout (root, after U2-U4)
Goal: assemble reviewable stack, validate, publish candidate previews, collect all required evidence, then scoped staff release and real OAuth demonstration.
Files: stack/PR descriptions, private evidence packet, native stack metadata and release configuration.
Approach: use GitHub native stacks; preserve original PR until replacement is safely published. Resolve review and CI; collect exact-version evidence and Slack tech permalink under authorized skill workflow; scoped deployment preserves owner data. Prepare Google form fields and video.
Verification: every affected surface qualified on current commit; no unknown critical policy/control gap; actual connect/read/approved-send/disconnect/deletion demonstrated with synthetic data. Google's final publishing and submission are reviewable user-confirmed actions.

## Process

Deployed restricted staff pilot → functional/security/privacy qualification and video → Google OAuth production status and submission with Matrix allowlist retained → Google's scope/policy review and assurance-level instructions → assessor quotes/engagement → assessment, remediation and Letter of Validation → Google final approval → separately controlled public rollout and annual revalidation.

## Auth and operational invariants

GET connection options and POST connect require verified owner identity; exact OAuth GET callback requires one-use state/PKCE/browser proof; mailbox actions retain stored account transport and current owner eligibility plus existing bot grants/one-use write approvals; DELETE and account deletion preserve same-client revoke cleanup even when native access is disabled. External calls remain bounded. No user-controlled callback owner and no Pipedream fallback for a native account.
