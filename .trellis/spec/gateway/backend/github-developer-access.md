# Owner GitHub developer access

## 1. Scope / trigger

Owner-local GitHub login, readiness, project clone, and collaboration Git.
Product and wiring details: `specs/634-github-developer-access/`. Mobile delivery and legacy
Pipedream retirement have separate acceptance gates.

## 2. Signatures

- Owner Terminal command: `matrix-github-developer-login` (no arguments).
- Owner-authenticated `GET /api/github/status`; no credential-bearing response.
- `POST /api/projects/clone` and GitHub-mode project creation share the same
  managed clone prerequisites.
- `githubOwnerEnvironment(homePath: string): NodeJS.ProcessEnv`.

## 3. Contracts

Metadata-only environment restores owner HOME/MATRIX_HOME, XDG_CONFIG_HOME,
GH_CONFIG_DIR, GIT_CONFIG_GLOBAL/NOSYSTEM and GH_HOST; inherited service tokens
and Git overrides are excluded. SSH uses strict published host pins and its
greeting must match the API account. Commit author and committer use confirmed
owner name/email. Existing HTTPS origins stay HTTPS.

The status service has one 7.5-second aggregate subprocess budget, inside the
10-second clients. Provider loading/failure cannot hide independent GitHub
status; setup stays disabled until Settings permissions are authoritative.
Managed clone requires authenticated GitHub CLI, SSH protocol and a verified
SSH greeting for the same account. Clone uses the same pinned SSH options as
the readiness probe, with Git URL rewrites disabled. Git identity is checked
when creating a commit.

Collaboration push and remote verification run from a fresh bare Git directory
with an explicit HTTPS or SSH GitHub URL. Push uses the approved commit SHA.
The transport reads repository objects for the push and ignores the checkout’s
Git config, including commands, includes, URL rewrites and credential helpers.
HTTPS uses the owner’s GitHub CLI credentials. SSH uses the owner’s pinned
GitHub host keys. Shallow boundaries and reciprocal linked worktree metadata
are validated as data. Push requires the approved objects to be locally
available and cannot fetch missing objects through a checkout’s promisor remote.

## 4. Validation and error matrix

| Condition | Required result |
| --- | --- |
| Missing login, mismatched SSH account or invalid author | Not ready; no mutation |
| Managed clone without GitHub CLI authentication | HTTP 424 `github_auth_required` before cloning |
| Managed clone with CLI auth and incomplete or mismatched SSH | HTTP 424 `github_ssh_setup_required`; Electron directs the user to Connect Apps → GitHub Developer |
| Unknown Settings permissions | Status/Refresh visible; setup disabled |
| Checkout Git config contains executable settings | Collaboration remote operations ignore checkout config |
| Cancellation/readback failure after mutation starts | Unknown effect; never auto-replay |
| gh ANSI cursor query before a newline | Forward bounded safe control frame; preserve secret redaction |

## 5. Good / base / bad cases

Good: owner SSH setup, private clone, owner-authored commit, and an approved
collaboration push of the exact SHA. Base: status reports incomplete setup.
Bad: treating Clerk sign-in as repository access or letting a shared checkout
choose the SSH command.

## 6. Required tests

Exercise real gh-style PTY input/piped-output cursor handshakes, split tokens and
multiline PEM suppression; shared aggregate status deadlines; actual local Git
author/committer, approved push SHA, managed clone with legacy HTTPS or a
different SSH account, and collaboration push and remote verification with
hostile checkout config. Qualification also needs an exact installed-version
owner flow against a private repository.

## 7. Wrong versus correct

Wrong: buffer all gh output until newline; run `git push origin HEAD` after a
stale approval; interpret a post-effect abort as a definite refusal.

Correct: recognize sanitized prompt text plus bounded terminal control frames;
push the approved SHA; retain uncertain effects for owner reconciliation.
