# Owner GitHub developer access

## 1. Scope / trigger

Owner-local GitHub login, readiness and the bounded Bot/Chat broker. Product and
wiring details: `specs/634-github-developer-access/`. Mobile delivery and legacy
Pipedream retirement have separate acceptance gates.

## 2. Signatures

- Owner Terminal command: `matrix-github-developer-login` (no arguments).
- Owner-authenticated `GET /api/github/status`; no credential-bearing response.
- `githubOwnerEnvironment(homePath: string): NodeJS.ProcessEnv`.
- Model tool `github_developer`, broker capability `github.developer`, shared
  `GithubDeveloperActionSchema`: status, clone, branch, commit, push, pull_request.

## 3. Contracts

Metadata-only environment restores owner HOME/MATRIX_HOME, XDG_CONFIG_HOME,
GH_CONFIG_DIR, GIT_CONFIG_GLOBAL/NOSYSTEM and GH_HOST; inherited service tokens
and Git overrides are excluded. SSH uses strict published host pins and its
greeting must match the API account. Commit author and committer use confirmed
owner name/email. Existing HTTPS origins stay HTTPS.

The status service has one 7.5-second aggregate subprocess budget, inside the
10-second clients. Provider loading/failure cannot hide independent GitHub
status; setup stays disabled until Settings permissions are authoritative.

Full-access private Chat/direct personal Bot mutations require exact canonical
approval bound to account, repository, branch, parent SHA, selected-file digest,
author and admitted owner/run/root/generation. A receipt is bounded, expiring
and single-use. Push sends an explicit approved SHA; PR is draft with actor and
head readback. Clone/index staging is owned, bounded, periodically recovered and
closed at shutdown. Workers never receive an owner shell or credentials.

## 4. Validation and error matrix

| Condition | Required result |
| --- | --- |
| Missing login, mismatched SSH account or invalid author | Not ready; no mutation |
| Unknown Settings permissions | Status/Refresh visible; setup disabled |
| Account/root/repository/content/author drift after approval | Refuse; fresh approval |
| Reserved metadata path, symlink or executable Git config | Refuse before effect |
| Cancellation/readback failure after mutation starts | Unknown effect; never auto-replay |
| gh ANSI cursor query before a newline | Forward bounded safe control frame; preserve secret redaction |

## 5. Good / base / bad cases

Good: owner SSH setup, approved private clone, explicit-file commit with ref CAS,
approved SHA push, verified draft PR. Base: status reports incomplete setup.
Bad: treating Clerk sign-in as repository access, mounting owner keys into a
worker, or applying an approval to changed repository state.

## 6. Required tests

Exercise real gh-style PTY input/piped-output cursor handshakes, split tokens and
multiline PEM suppression; shared aggregate status deadlines; actual local Git
author/committer, separate index and expected-HEAD CAS; exact remote SHA/draft
readback; canonical Chat/Bot approval and staging TTL/shutdown. Qualification
also needs exact installed-version private-repository user/Bot/Chat outcomes and
matching Web Canvas, Web Desktop and Electron Desktop media.

## 7. Wrong versus correct

Wrong: buffer all gh output until newline; run `git push origin HEAD` after a
stale approval; interpret a post-effect abort as a definite refusal.

Correct: recognize sanitized prompt text plus bounded terminal control frames;
push the approved SHA; retain uncertain effects for owner reconciliation.
