# Matrix OS Changelog

This changelog summarizes notable Matrix OS changes on `main`.

Format:

- Entries are grouped by date.
- Commit hashes point at the source of truth.
- Large features may also have feature-specific changelogs under `specs/<NNN>-<feature>/`.

## 2026-04-28

### VPS-per-User Customer Host Completion

Matrix OS can now complete the phase-1 customer VPS boot path instead of leaving customer machines stuck in `provisioning`.

Highlights:

- Built and published the customer host bundle expected by Spec 070.
- Made customer cloud-init download and verify the bundle with a `.sha256` sidecar.
- Fixed Hetzner bootstrap defaults for current availability (`cpx22`) and Ubuntu 24.04 behavior.
- Fixed customer host registration so the platform row reaches `running`.
- Fixed shell routing on customer VPSes by trusting platform-authenticated bearer traffic before Clerk middleware initializes.
- Added customer-host R2 credentials and fixed hourly Postgres backup uploads.
- Bundled Matrix coding agent CLIs (`claude`, `codex`, `opencode`, `pi`) into customer VPS hosts.

Commits:

- `38e4fe1d` `feat: publish customer VPS host bundle`
- `08392959` `fix: default customer VPS provisioning to cpx22`
- `7ca05c3f` `fix: use existing R2 credentials for host bundle`
- `2d915f15` `fix: serve host bundles through platform tunnel`
- `91a4b43d` `fix: allow large customer VPS bundle downloads`
- `5601bab9` `fix: use production customer VPS cloud-init`
- `e8c30d36` `fix: keep generated artifacts out of docker context`
- `d13ad917` `fix: keep customer VPS cloud-init YAML valid`
- `55e54273` `fix: create customer VPS matrix group before write_files`
- `fcd0b2bd` `fix: make customer VPS bootstrap compatible with noble`
- `820477ed` `fix: make customer VPS apt bootstrap fail fast`
- `c86d8c77` `fix: complete customer VPS host registration`
- `1f6c4185` `fix: trust platform auth on customer VPS shell`
- `095b7041` `fix: provision customer VPS backup credentials`
- `d9fea1ea` `fix: bundle coding agent CLIs for customer VPS`

Detailed notes: `specs/070-vps-per-user/changelog.md`

### Cloud Coding Workspaces

Added the cloud coding workspace foundation, including workspace routes and related app/platform changes.

Commits:

- `c72f3e24` `feat: add cloud coding workspaces (#61)`

Spec: `specs/069-cloud-coding-workspaces/`

### Shell Terminal And Zellij Foundation

Added zellij shell and terminal parity foundation work, continuing the terminal app upgrade path.

Commits:

- `3a241e26` `feat(shell): add zellij shell and terminal parity foundation (#62)`

Related specs:

- `specs/056-terminal-upgrade/`
- `specs/068-zellij-cli/`

### Workspace Canvas

Added the workspace canvas feature.

Commits:

- `cba0c5d7` `feat(canvas): add workspace canvas (#64)`

Spec: `specs/071-tldraw-workspace-canvas/`

### CI

Improved CI throughput by parallelizing test workflows.

Commits:

- `9157067f` `ci: parallelize test workflows (#65)`

## 2026-04-27 And Earlier Recent Work

### VPS-per-User Foundation

Added the first platform-side VPS-per-user provisioning and recovery foundation.

Commits:

- `284d5133` `feat: add vps-per-user provisioning and recovery foundation`

Spec: `specs/070-vps-per-user/`

### Container And Runtime Fixes

Improved container runtime behavior and provenance for the legacy container path.

Commits:

- `3ea8c962` `fix(container): seed zsh config and stamp image provenance`
- `e195a071` `fix(platform): pass PLATFORM_PUBLIC_URL through compose`
- `fa0d84e4` `chore: add container debug tooling`
- `2aa08b43` `feat(container): install bubblewrap for codex sandbox (#54)`
- `f58bf123` `fix(container,terminal): agent auto-updates, gh CLI, reconnect banner cleanup (#53)`

### Spec Kit And Tooling

Added Spec Kit tooling and Codex integration.

Commits:

- `b9b7064f` `Add Speckit Codex integration`
- `c47770b9` `chore: add speckit tooling`

### Sync Client Resilience

Improved sync-client behavior when the manifest cache is stale.

Commits:

- `2599b4ae` `fix(sync-client): recover from stale manifest cache instead of crashing (#58)`

### Terminal, Voice, And App Runtime

Recent product-facing shell/runtime work before the VPS completion slice.

Commits:

- `7a0c2ef8` `feat: terminal app redesign + zellij/pi/ssh + staging hot-reload (#56)`
- `9dfe17db` `fix: unbreak voice-first onboarding + 063 seed apps in production (#55)`
- `1aafdf61` `feat(063): React app runtime with static/vite/node modes and publish CLI (#29)`
- `80aa8ff1` `feat: voice-first onboarding and Aoede ambient overlay (#31)`
- `47e16169` `fix: preserve terminal sessions across tab switches (#49)`

Related specs:

- `specs/063-react-app-runtime/`
- `specs/066-vocal-voice-mode/`
- `specs/068-zellij-cli/`

## Maintenance Notes

- Keep this root changelog high level.
- Put detailed rollout/debug notes in feature-specific changelogs when a feature has substantial operational behavior.
- For future release tags, add a version heading above the date-based sections.
