# GitHub Developer Access Core

## Goal

Give each Matrix computer owner a terminal-driven GitHub setup that leaves GitHub CLI credentials, SSH keys, host verification, and Git commit identity in owner-controlled runtime files. After setup, the headless core can clone a private repository over SSH and coding agents can commit, push, and open a pull request as the owner.

## Scope

- Add the fixed `matrix-github-developer-login` terminal command.
- Extend `GET /api/github/status` without removing the existing `installed`, `authenticated`, or `user` fields.
- Use canonical `git@github.com:<owner>/<repo>.git` remotes for new managed clones.
- Preserve existing HTTPS remotes and configure GitHub CLI as their credential helper.
- Require a validated owner Git identity for user-facing coding-agent commits.

Web, Electron, and mobile renderers are separate ENG-378 and ENG-379 changes. Pipedream retirement is ENG-382. Public documentation is ENG-380. Clerk sign-in, rich GitHub APIs, key rotation, and key-deletion UI are deferred.

## Owner Journey

1. The owner runs `matrix-github-developer-login` in their Matrix computer terminal.
2. The command runs `gh auth login --hostname github.com --web --git-protocol ssh`. GitHub CLI detects an existing public key or creates and uploads a new public key; Matrix never accepts or uploads a private key.
3. The command installs GitHub's published host keys into an owner-local pinned known-hosts file and verifies `ssh -T git@github.com` with strict checking and a bounded timeout.
4. It configures GitHub CLI's Git credential helper for existing HTTPS remotes.
5. If global Git identity is missing or invalid, it proposes the GitHub display name/login and `<id>+<login>@users.noreply.github.com`. The owner may confirm or edit both values before either is saved.
6. Status becomes ready only when GitHub auth, SSH, and commit identity are all ready.

## Source Of Truth And Credentials

- GitHub CLI auth remains in the owner's `.config/gh` directory.
- SSH public/private key material remains in the owner's `.ssh` directory. Matrix reads no private-key bytes and accepts no private-key input.
- Git identity remains in the owner's global `.gitconfig`.
- The platform stores no GitHub token, OAuth callback, SSH key, or developer identity.
- Managed project config stores the canonical GitHub SSH remote for newly cloned projects. Existing project remotes are not rewritten.

## Host-Key Trust

The pinned `github.com` Ed25519, ECDSA, and RSA host-key entries are copied from GitHub's official “GitHub's SSH key fingerprints” documentation and were verified on 2026-10-24. Runtime setup never downloads or trusts host keys from the network. SSH verification uses only the pinned owner-local file, strict host-key checking, no global known-hosts fallback, batch mode, one connection attempt, and a bounded connection timeout.

## API Contract

`GET /api/github/status` keeps its legacy fields and adds:

- `gitProtocol: "ssh" | "https" | null`
- `sshStatus: "verified" | "setup_required" | "unavailable"`
- `commitIdentity: { status: "ready" | "missing" | "unavailable"; label: string | null }`
- `ready: boolean`
- `errorCode`: `null` or one bounded allowlisted setup/error code

GitHub logins, identity values, and labels are schema-validated and bounded. The response never includes command output, paths, tokens, SSH material, or raw errors.

## Auth Matrix

| Route | Method | Auth source | Public |
| --- | --- | --- | --- |
| `/api/github/status` | GET | Existing gateway owner-session middleware | No |

The terminal command is not an HTTP endpoint. It executes as the Matrix computer owner inside an already authorized terminal session.

## Failure, Recovery, And Resource Policy

- Every non-interactive child command has a timeout and bounded output.
- Browser login has a finite overall timeout and forwards cancellation signals to GitHub CLI.
- A cancelled or failed login leaves any GitHub CLI-owned partial state recoverable by rerunning the command.
- Identity values are validated before writes. A failed Git config write is reported generically and setup remains not ready.
- Host-key files are written atomically with restrictive modes; symlink targets are rejected.
- Setup is idempotent: reruns preserve valid identity and let GitHub CLI reuse existing keys.
- Status probes are read-only and classify missing setup separately from unavailable executables or command failures.
- No in-memory collection, database row, temporary clone, or platform credential is added. Existing clone staging cleanup remains authoritative.

## Integration Wiring

The host bundle copies `distro/customer-vps/host-bin/matrix-github-developer-login` into `/opt/matrix/bin`. Renderer work in ENG-378 and ENG-379 launches that fixed command through the existing terminal-session handoff. The gateway status route calls the project manager, which probes the same owner-local GitHub CLI, SSH, and Git configuration. Managed project creation clones the validated repository using its canonical SSH URL. Coding-agent source control resolves and validates the repository's effective owner identity before committing, then uses the existing GitHub CLI path for push and PR creation.

## Acceptance And Tests

- Fake-executable tests cover exact login sequencing, cancellation, existing-key delegation, strict SSH verification, identity confirmation/editing, validation, and redaction.
- Gateway tests cover ready and partial status, timeouts, output bounds, safe error codes, and the compatible legacy fields.
- Project tests prove new clones use SSH while existing HTTPS remotes are not rewritten.
- Source-control tests prove commits use configured owner identity and fail safely when it is absent or invalid.
- A disposable VPS and private test repository must prove browser login → SSH verification → private clone → correctly attributed commit → pushed branch → PR.
- Public docs ship separately in `FinnaAI/matrix-os-site` under ENG-380.

