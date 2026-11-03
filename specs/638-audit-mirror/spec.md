# Temporary audit source mirror in GitHub Actions

Task: [GTM-305](https://linear.app/matrix-os/issue/GTM-305/remediate-the-vanta-github-dependency-vulnerability-backlog), existing Vanta dependency-ingestion/remediation work. Proposed only; no credential grants or activation performed.

Finna Labs Inc. / Matrix OS. Owner: Hamed Mohammadpour. Upstream remains HamedMP/matrix-os; FinnaAI/matrix-os remains a public source/dependency collection mirror. Keep upstream bypasses unchanged.

## Behavior and wiring

The upstream workflow tests the real Git transport, then runs hourly, on main pushes, or manually from main. Pull requests execute safety tests only. A repository variable gates live synchronization and defaults to disabled. Mirror Actions stay disabled, preventing copied upstream workflows from running there. No application checkout, package install, source build or deployment occurs during synchronization. Node 24 and official Actions are pinned by SHA.

A fresh temporary bare repository fetches only main (no tags), verifies the mirror is an ancestor of source, refetches source without force, checks destination policy again, refuses concurrent destination changes, pushes one explicit main ref with ordinary Git fast-forward protection, then verifies equality and policy. Refuse independent commits, rewritten synchronized history, authentication failure, malformed/changed policy and missing destination main. Never recreate or force a missing/diverged mirror. Source may advance after the verified snapshot; the next trigger catches up. A rewrite of never-synchronized source commits cannot be detected from mirror ancestry alone.

Concurrency serializes upstream main sync jobs. HTTP calls have 10-second aborts; Git processes have four-minute bounds; the job has a 15-minute bound. Temporary bare storage and askpass files are removed in finally blocks. Git error output is sanitized to avoid leaking authentication. Failed runs remain visible in GitHub; successful/unchanged syncs create no messages. Use normal GitHub workflow failure notifications; no email or Slack sends are configured by this change.

## Credential and security architecture

Create a dedicated GitHub App installed only on FinnaAI/matrix-os. Grant repository Contents write (main copy), Workflows write (GitHub requires this to copy changes to .github/workflows), Administration read (verify Actions are disabled), and implicit Metadata read. No Actions write, administration write, organization permissions, PR permissions or access to other repositories. Workflows write does not enable Actions; it is needed to mirror the existing source tree exactly. Do not reuse personal broad tokens or the Vanta integration.

The App private key belongs in the existing appropriate Engineering vault in the Matrix OS 1Password account and in upstream repository secret MATRIX_AUDIT_MIRROR_APP_PRIVATE_KEY. Never place it in a repository/file/chat/log/command argument. App ID is repository variable MATRIX_AUDIT_MIRROR_APP_ID. Request an installation token limited to the one repository and three permissions for each run; official action revokes it afterward. Enable with MATRIX_AUDIT_MIRROR_ENABLED=true only after exact approval, review, merge and credential provisioning. Git uses environment-based askpass; no embedded token URLs or stored Git credentials.

Auth sources: upstream GITHUB_TOKEN read-only for controller checkout; destination-only App token for policy reads and main push. No anonymous write fallback. Public Git source fetch is read-only. Controller executes the workflow revision from upstream, never fetched mirror code. There are no new service endpoints or user-facing surfaces; all five application surface gates are N/A because only an administrative source-copy workflow changes. Reviewer should confirm this boundary.

## Acceptance and rollout

- Tests use actual local source/destination Git repositories: exact main equality, branch/tag exclusion, no-change state, source rewrite, mirror divergence, concurrent updates, pre-write guard failure, post-write failure, malformed metadata, sanitized auth failure.
- Run workflow tests on PR without secrets. Require review and current-head CI before merge. Infrastructure owner Hamed should review the permission scope and stop conditions.
- After approval, create/install the App, securely store its key, set variables/secret, merge through normal review and manually dispatch once. Verify source/destination SHA equality, disabled mirror Actions, only main updated and a factual run receipt. This live path is untested until access is approved/provisioned.
- Verify Vanta's mirror inventory and dependency ingestion after its refresh. Retain independent upstream PR/CI/access evidence. Do not treat empty mirror PR history as compliant review.
- Stop by setting the enable variable false and revoking the App installation/key. Do not delete historical evidence. Codex hourly automation was deleted at Hamed's request on 29 October 2026; there is intentionally no active replacement yet.

## Deferred

Repository transfer, CI migration, deployments, bypass changes, audit exceptions, dependency fixes and sending correspondence. Missing credentials or review block activation, not local preparation. Customer documentation is not affected; this is an internal temporary audit collection procedure.

References: [Git access permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app), [Actions policy API](https://docs.github.com/en/rest/actions/permissions#get-github-actions-permissions-for-a-repository), [installation token action](https://github.com/actions/create-github-app-token).
