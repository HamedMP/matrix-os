# GitHub Developer Access Core

## Goal

Give each Matrix computer owner GitHub setup from Settings or Terminal that leaves GitHub CLI credentials, SSH keys, host verification, and Git commit identity in owner-controlled runtime files. After setup, the headless core can clone a private repository over SSH and coding agents can commit, push, and open a pull request as the owner.

## Scope

- Provide the fixed `matrix-github-developer-login` Terminal command and an owner-bound Settings setup operation.
- Extend `GET /api/github/status` without removing the existing `installed`, `authenticated`, or `user` fields.
- Use canonical `git@github.com:<owner>/<repo>.git` remotes for new managed clones.
- Preserve existing HTTPS remotes and configure GitHub CLI as their credential helper.
- Require a validated owner Git identity for user-facing coding-agent commits.

Web, Electron, and mobile renderers are separate ENG-378 and ENG-379 changes. Pipedream retirement is ENG-382. Public documentation is ENG-380. Clerk sign-in, rich GitHub APIs, key rotation, and key-deletion UI are deferred.

## Owner Journey

### Settings device authorization

On the selected computer, Connect Apps starts a bounded device login and opens the
GitHub Developer dialog. It shows the one-time code, **Copy**, and **Open GitHub**.
The owner completes authorization at `https://github.com/login/device` while
GitHub CLI polls on the computer. The operation uses the installed GitHub CLI and
its owner-local credential store.

Setup reuses a key that already authenticates the same GitHub account. If a key
must be registered, it defaults to the first eligible local SSH key pair in the
CLI's sorted order. The pair must match and work without a passphrase or hardware
interaction. Setup creates a dedicated owner-local key if no pair qualifies.
It uploads only the public key and verifies the SSH account with the pinned host
keys. Missing Git author identity defaults to the verified GitHub profile and
GitHub noreply address. Existing valid identity is preserved. The card refreshes
`GET /api/github/status` on completion and reflects the computer's actual readiness.

### Manual Terminal setup

1. The owner runs `matrix-github-developer-login` in their Matrix computer terminal.
2. The command runs `gh auth login --hostname github.com --web --git-protocol ssh` with GitHub CLI's accessible prompter fixed on for this login child. This keeps the owner's questions in the current Terminal viewport instead of relying on the default survey cursor-position probe. GitHub CLI detects an existing public key or creates and uploads a new public key; Matrix never accepts or uploads a private key.
3. The command installs GitHub's published host keys into an owner-local pinned known-hosts file and verifies `ssh -T git@github.com` with strict checking and a bounded timeout.
4. It configures GitHub CLI's Git credential helper for existing HTTPS remotes.
5. If global Git identity is missing or invalid, it proposes the GitHub display name/login and `<id>+<login>@users.noreply.github.com`. The owner may confirm or edit both values before either is saved.
6. Status becomes ready only when GitHub auth, SSH, and commit identity are all ready.

The browser-wait instruction must be visible before GitHub CLI waits for Enter,
including styled and chunked output. SSH must authenticate the same GitHub
account as the owner's GitHub CLI API identity; a different account remains
setup-required and must not announce readiness or save identity suggestions.

## Source Of Truth And Credentials

- GitHub CLI auth remains in the owner's `.config/gh` directory.
- SSH public/private key material remains in the owner's `.ssh` directory. Matrix reads no private-key bytes and accepts no private-key input.
- Git identity remains in the owner's global `.gitconfig`.
- The platform stores no GitHub token, OAuth callback, SSH key, or developer identity.
- Login, readiness, managed clone, and coding-agent source control bind the
  owner's home and configuration explicitly. Child commands receive only
  process metadata (path, locale, temp, proxy/TLS and SSH-agent settings), not
  gateway secrets, inherited GitHub tokens or Git command/config overrides.
- Managed project config stores the canonical GitHub SSH remote for newly cloned projects. Existing project remotes are preserved.
- Managed clone checks that GitHub CLI and SSH authenticate the same account and uses the pinned GitHub host keys. If SSH setup is incomplete, Electron Add Project directs the owner to **Settings → Connect Apps → GitHub Developer** to finish setup and retry.

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

The Settings setup endpoints return an opaque operation UUID and state.
`awaiting_authorization` alone includes `deviceCode`, with the format `XXXX-XXXX`.
`starting`, `succeeded`, `failed`, `expired`, and `cancelled` contain no code.
The client opens the fixed GitHub device verification page. Responses use
`Cache-Control: private, no-store`.

## Auth Matrix

| Route | Method | Auth source | Public |
| --- | --- | --- | --- |
| `/api/github/status` | GET | Existing gateway owner-session middleware | No |
| `/api/github/setup` | POST `{}` | Selected computer owner with writable Settings | No |
| `/api/github/setup/:id` | GET | Selected computer owner and matching operation | No |
| `/api/github/setup/:id/cancel` | POST `{}` | Selected computer owner and matching operation | No |

The manual command runs inside an authorized owner Terminal session. Settings invokes the fixed command with `--settings` in the selected computer gateway.

## Failure, Recovery, And Resource Policy

- Every non-interactive child command has a timeout and bounded output.
- Browser login has a finite overall timeout and forwards cancellation signals to GitHub CLI.
- Interactive output redaction tracks private-key blocks per stream across
  chunks and line boundaries, including an unfinished block at process exit;
  suppressing only PEM headers is insufficient.
- A cancelled or failed login leaves any GitHub CLI-owned partial state recoverable by rerunning the command.
- Identity values are validated before writes. A failed Git config write is reported generically and setup remains not ready.
- Host-key files are written atomically with restrictive modes; symlink targets are rejected.
- Setup is idempotent: reruns preserve valid identity and let GitHub CLI reuse existing keys.
- Status probes are read-only and classify missing setup separately from unavailable executables or command failures.
- Status probing shares one 7.5-second aggregate subprocess budget, leaving
  response headroom inside Web/Electron's ten-second request deadline. Every
  child receives only the remaining budget; expired probes are not started.
  Local identity checks run independently so a dropped SSH connection still
  returns an accurate, safe partial status. Interactive CLI setup retains its
  separate longer login and verification timeouts.
- The Settings gateway tracks at most one setup operation per computer. The child and code expire, and shutdown cancels active work. No operation or code is persisted in the database. Existing clone staging cleanup remains authoritative.

## Integration Wiring

The host bundle copies `distro/customer-vps/host-bin/matrix-github-developer-login` into `/opt/matrix/bin`. Web and Electron in ENG-378 use the owner-bound Settings operation. ENG-379 remains a separate Mobile delivery. The gateway status route calls the project manager, which probes the same owner-local GitHub CLI, SSH, and Git configuration. Managed project creation clones the validated repository using its canonical SSH URL. Coding-agent source control resolves and validates the repository's effective owner identity before committing, then uses the existing GitHub CLI path for push and PR creation.

## Web and Electron setup entry (ENG-378)

In Web Canvas, Web Desktop, and Electron Desktop, show **GitHub Developer**
as its own card in **Connect Apps**. Getting Started opens that section with
the card at the top. The card reports readiness for the selected computer,
independently of the app catalog and any existing GitHub connection.

Show **Connect** for missing setup and **Finish setup** for incomplete setup.
Open the same owner Terminal command from either action once Settings permissions
are confirmed. Recheck status on return to the app. A ready card reports its
state and offers no setup action. Retry failed status or permission checks
from the card. Electron also retries a failed Terminal handoff there. Web
uses its existing Terminal recovery path. Discard results from a previously
selected computer.

## Acceptance And Tests

- Fake-executable tests cover exact login sequencing, cancellation, existing-key delegation, strict SSH verification, identity confirmation/editing, validation, and redaction.
- Gateway tests cover owner scope, setup lifecycle and canonical completion, ready and partial status, timeouts, output bounds, safe error codes, and the compatible legacy fields.
- Project tests prove new clones use SSH while existing HTTPS remotes are not rewritten.
- Source-control tests prove commits use configured owner identity and fail safely when it is absent or invalid.
- A disposable VPS and private test repository must prove browser login → SSH verification → private clone → correctly attributed commit → pushed branch → PR.
- Public docs ship separately in `FinnaAI/matrix-os-site` under ENG-380.
