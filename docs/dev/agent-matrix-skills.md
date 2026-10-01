# Agent Matrix Skills

Matrix ships an Agent-installable skill pack under `skills/matrix/`. These skills teach agents how to build and debug Matrix apps, use the Matrix design system, work with Matrix integrations, and operate on a dev VPS. The pack also ships the owner-provided design and animation skill snapshots with their relative resources and per-skill `PROVENANCE.md`.

`skills/matrix/` is the source of truth for Matrix-hosted coding agents. Runtime sync projects every skill directory with a `SKILL.md` into the tool-specific locations for Matrix, Claude Code, Codex, and Hermes.

## Skills

| Skill | Purpose |
| --- | --- |
| `matrix-app-builder` | Build Matrix apps as Vite React TypeScript projects with `matrix.json` and verified `dist/` output. |
| `matrix-app-ui-patterns` | Build stable app interiors for windowed, mobile, dashboard, data, and canvas contexts. |
| `matrix-design-system` | Apply Matrix theme, shadcn-style component patterns, icon quality rules, and iframe-safe app layouts. |
| `matrix-integrations` | Use platform-owned Matrix integrations without copying provider secrets into Agent or customer VPSes. |
| `matrix-dev-vps` | Develop Matrix from inside a user/dev VPS with hot reload, previews, and auth-aware tunnels. |
| `matrix-debug-app` | Fix `needs_build`, manifest problems, bundle/icon 404s, console errors, and integration proxy issues. |
| `matrix-landing-design` | Build public Matrix OS marketing and landing surfaces without mixing those patterns into apps. |
| `matrix-chat-import` | Import owner-selected Codex/Claude transcripts as private Matrix Chats. |
| `matrix-personal-daily-brief` | Prepare a personal briefing from connected services. |
| `matrix-jev-email-triage` | Triage email through the scoped Matrix workflow. |
| `emil-design-eng` | Refine hierarchy, components, UI details, and interaction polish. |
| `apple-design` | Build fluid direct manipulation, gestures, and spatial continuity. |
| `animate` | Choose and implement purposeful web motion with local recipe references. |
| `animation-vocabulary` | Identify effects and useful motion terminology. |
| `animation-accessibility` | Design/test reduced-motion alternatives and accessible media behavior. |
| `animation-performance` | Diagnose dropped frames and choose efficient animation properties. |
| `css-animations` | Implement CSS motion with worked recipes. |
| `review-animations` | Inspect the implemented motion against craft/accessibility/performance criteria. |

Every skill supplies top-level discovery triggers. Matrix companion names also appear
in top-level `related_skills` and harness metadata; discovery presents names while
full bodies and resources load on demand. Avoid eagerly injecting the entire pack.
The local snapshots retain original attribution and do not claim Matrix authorship
or an upstream license that was not supplied. Host-specific configuration is excluded.

## Install Into Agent

### One Command

From a Matrix checkout:

```bash
./scripts/install-agent-matrix-skills.sh
```

The script installs the shipped Matrix app skills from `HamedMP/matrix-os` by default. To install from a local path or another tap/source:

```bash
./scripts/install-agent-matrix-skills.sh /home/matrix/projects/matrix-os
MATRIX_SKILLS_SOURCE=HamedMP/matrix-os ./scripts/install-agent-matrix-skills.sh
AGENT_BIN=/opt/matrix/runtime/node/bin/agent ./scripts/install-agent-matrix-skills.sh
```

Both installer scripts enumerate the same complete pack. A direct local
`skills/matrix` path is accepted as well as a checkout root. Hermes local installation
uses the shared synchronizer; published-source installation does not use `--force`.
Agent repeat installation fills missing names only and preserves existing files,
directories, and dangling links under `${AGENT_HOME:-$HOME/.agent}/skills`. Set
`MATRIX_AGENT_SKILLS_ROOT` to guard a nonstandard Agent skills destination.

Runtime sync preserves existing user-managed skills, including a same-name local
`animate` or `apple-design`. Shipped vendored directories contain a `.matrix-os-managed`
marker so a previous release's links/copies can be refreshed without assigning Matrix
authorship to the underlying skill. Only current-source links, explicit markers, and
legacy `matrix-*` directories authored by Matrix are eligible for cleanup. Uncertain
or unmarked same-name installations remain untouched and a skip is reported. The
source pack under the current release is the instruction/resource source of truth.
Owner-named symlink aliases remain intact even when they point into the shipped
pack: source ownership or a followed marker does not make an alias Matrix-managed.

## Codex Plugin

Matrix also exposes the repo-scoped **Matrix OS** Codex marketplace product at
`.agents/plugins/marketplace.json`. It helps a local Codex set up and recover a Matrix cloud
computer, run bounded commands or coding-agent tasks, and safely clone or modify GitHub projects.
The plugin ID and installed skill namespace are `matrix-os`, matching the visible product name.

```bash
codex plugin marketplace add "$(pwd)"
```

After Codex refreshes the marketplace, enable **Matrix OS** (`matrix-os`) and try one of its
starter prompts:

```text
Build a new app on my Matrix computer.
Clone this GitHub repo on Matrix and make a change.
Run this command on my Matrix computer.
```

The product bundles three focused skills:

| Skill | Purpose |
| --- | --- |
| `matrix-onboarding` | Matrix setup, authentication, diagnostics, and recovery. |
| `matrix-cloud-run` | Bounded commands and sandboxed coding-agent tasks on Matrix. |
| `matrix-github-project` | Collision-safe GitHub clone, checkout reuse, changes, and validation. |

All authentication happens through browser/device flows inside Matrix. The skills never require
copying local credential files to the cloud computer. Every remote command creates a tab in the
resolved project workspace and reports the matching `matrix shell connect --project <project>
--tab <tab-id>` command. Each additional terminal or concurrent task gets another tab.

If you installed an unpublished preview under the old `matrix-onboarding` namespace, remove that
preview and install the renamed plugin once:

```bash
codex plugin remove matrix-onboarding@matrix-os
codex plugin add matrix-os@matrix-os
```

## Move a Local Task to Matrix

The repo-scoped `matrix-handoff` skill under `.agents/skills/matrix-handoff/` safely moves the
active working tree and a continuation brief to a new project directory on the user's Matrix
computer, then starts Codex or Claude there. Claude also exposes the workflow as
`/matrix-handoff` through `.claude/commands/matrix-handoff.md`.

The workflow has two explicit phases:

1. Preview the filtered file count, optional repository-matched transcript, destination, agent,
   and a SHA-256 scope approval token.
2. After the user approves that exact scope, rerun with `--approve TOKEN`. The script stages the
   inputs again and refuses to upload if the files, brief, transcript, agent, profile, or
   destination basis changed after preview.

Common secret files, `.env` files, private keys, `.git`, dependencies, and generated output are
excluded. Use `--no-history` for a summary-only handoff that does not discover or upload a raw
agent transcript. Authentication is never copied; GitHub and the selected coding agent must use
their own browser/device flow or Matrix-managed key inside the runtime.

Example prompts:

```text
Use $matrix-handoff to move this task to Matrix with Codex, using --no-history.
/matrix-handoff --agent claude --no-history
```

## Preconfigure Agent In Matrix

Recommended target state:

1. The VPS-native host runtime includes Agent or installs it during first boot as the `matrix` user.
2. First boot runs `scripts/install-agent-matrix-skills.sh`.
3. Gateway startup runs `scripts/sync-matrix-agent-skills.sh` so Matrix, Claude Code, Codex, and Hermes see
   the same canonical skill pack.
4. Agent config sets Matrix's local gateway URL:

   ```bash
   agent config set skills.config.matrix.gateway_url http://localhost:4000
   ```

5. No Pipedream, Clerk, Gmail, GitHub, Slack, or provider secrets are written to Agent config or customer VPS env.

For production user VPSes, preinstalling Agent plus the Matrix skills is safe because the skills contain instructions only. Authenticated Matrix actions should still go through Matrix gateway/platform APIs.

For dev VPSes, also make the Agent install path writable by the `matrix` user so Agent, Codex, and Claude CLIs can self-update without `EACCES`.

## Developer CLI Bootstrap

The developer ICP should be able to sign up, receive a VPS, and let their coding agent finish setup through the same terminal primitive the web shell uses. Do not create a separate SSH-style path for interactive commands.

Document this minimal command surface for agents and humans:

```bash
matrix login --profile cloud
matrix doctor
matrix whoami
matrix status
matrix instance info --json
matrix run -it --project example -C projects/example -- git status --short
matrix run -it --project example -C projects/example -- codex --ask-for-approval never --sandbox workspace-write
matrix shell list
matrix shell connect --project example --tab <tab-id>
```

`matrix run -it --project <project> -C <dir> -- <argv...>` selects an existing directory, creates a
tab in that project's Zellij workspace, starts the requested command, and attaches the local terminal
over `/ws/terminal/tab`. `-C` does not create the directory. The local terminal is a dumb TTY: stdin
is put in raw mode, Ctrl-C/Ctrl-D are forwarded to the remote process, terminal resizes are
forwarded as `resize` frames, and `Ctrl-\ Ctrl-\` detaches without killing the remote session.

Always create Matrix CLI tabs for remote commands, including readiness probes and short commands.
Each project owns one workspace; concurrent work gets another tab. Report the returned tab ID and
its `matrix shell connect --project <project> --tab <tab-id>` command immediately.

`matrix instance info --json` reads authenticated instance metadata from the gateway. A successful
structured response confirms metadata reachability, not command execution. Use `matrix doctor` and
a separate bounded one-shot `matrix run --project main -- true` command when a workflow requires an
execution health check; do not infer execution readiness from `matrix instance info`.

Use the reserved `main` workspace for setup workflows so the user, Matrix web terminal, Claude, Codex, or Hermes can all view the same tab:

Create separate tabs for unrelated workflows and use the stable tab ID for reconnects; display names are not identities and may be duplicated.

If `matrix run -it` or `matrix shell new` fails, do not keep retrying the same command. Run
`matrix shell list`, then use `matrix shell connect --project <project> --tab <tab-id>` against an
existing tab. If creation still fails, ask the human to choose an existing tab in Matrix.

For unattended Codex work, pair `--ask-for-approval never` with `--sandbox read-only` or
`--sandbox workspace-write` and scope `-C` to the narrow target. For Claude Code, use
`claude --permission-mode auto -p <prompt>` in its own tab to avoid repetitive permission
questions while retaining Claude's safety classifier. If auto mode is unavailable, stop and report
the limitation; never fall back to a permission bypass. Never use Codex `danger-full-access`
without explicit user direction.

## Provisioning Hook

The bootstrap step should run after the Matrix runtime user exists and before the shell is presented as ready:

```bash
su - matrix -c 'if test -x /home/matrix/projects/matrix-os/scripts/install-agent-matrix-skills.sh; then cd /home/matrix/projects/matrix-os && ./scripts/install-agent-matrix-skills.sh; else echo "Matrix skills checkout not present; skipping local skill install"; fi'
su - matrix -c 'agent config set skills.config.matrix.gateway_url http://localhost:4000'
```

If the checkout is not present in `/home/matrix/projects/matrix-os`, skip the first command and install
the Matrix skills from the published source or the release-bundled skill path instead.

If Agent is not installed yet, install it into a user-writable prefix owned by `matrix`, not a root-owned global npm prefix.

## Security Boundary

The skills intentionally do not request Pipedream, Clerk, Gmail, GitHub, Slack, or provider secrets. Agent should call Matrix gateway/platform APIs with Matrix auth. Platform owns integration credentials and user connection state.

## Recommended Future Toolset

Skills are enough for instruction-heavy workflows. For reliable authenticated actions, add an Agent `matrix` toolset with:

- `matrix.list_apps`
- `matrix.read_file`
- `matrix.write_file`
- `matrix.run_app_build`
- `matrix.open_app`
- `matrix.list_integrations`
- `matrix.connect_integration`
- `matrix.call_integration`
- `matrix.get_preview_url`

The skills can then prefer those tools and fall back to shell/curl when the toolset is unavailable.

## App build quality and launch verification

The app-builder skill ships `scripts/verify-app.mjs`. Run it with the absolute app
directory after the production build. It checks the owner-built Vite contract, including
`listingTrust: "first_party"`, personal scope, and `dist/index.html`. Missing trust causes
a policy rejection even when compilation succeeds. The verifier is read-only and must
never be used to relabel imported/community apps. Only HTTP 401 from the native app launch
request should ask for login; policy, manifest, network, and server failures are app failures.

Builders must then launch through Matrix, verify the icon/assets and bridge, save and
reopen data, and inspect the main flow at normal and narrow sizes. Record untested surfaces.
A local Vite preview or successful build does not prove an authenticated Matrix launch.

Design guidance lives in the builder's `references/app-craft.md`, with Matrix tokens and
layout guidance in its companion skills. Discover actual paths through the harness
catalog and load only task-relevant design/motion bodies and resources. The shipped
local `emil-design-eng`, `apple-design`, `animate`, and supporting snapshots preserve
their original attribution in `PROVENANCE.md`; do not assume they are official packages
from a particular repository. If a skill is unavailable on a route, report that and
use the craft reference. Runtime sync keeps unmarked user-managed versions intact.

Choose task-specific layouts, clear typography, truthful states, and useful interactions.
Gradients, glass, capsule controls, and mount staggering are not universal requirements.
Frequent and keyboard actions stay immediate; occasional motion communicates state or
spatial relationships and respects reduced motion. Verify in Web Canvas, Web Desktop,
and Electron Desktop where available, plus supported mobile surfaces.


## Direction, data and evidence

Before scaffolding, builders keep a concise app `DESIGN.md` with the user's main task,
layout/density, theme tokens, typography/spacing, data/state contract, and a concrete
motion/reduced-motion recipe. Follow supplied references or existing app direction
by default. Small alternatives are useful when requested or when they resolve a real
ambiguity; they do not create a mandatory design approval pause.

Build one complete vertical slice through the existing `window.MatrixOS.db` bridge
and owner's Postgres: bounded read, create/edit, confirmation/failure rollback, and
save/reopen verification. A missing bridge is a visible error, never successful
local storage. Avoid fake records, duplicate seeding, stale rollback snapshots, and
sequential multi-request workflows presented as database transactions. Structured
data belongs in Postgres; code, manifests, `DESIGN.md`, and assets remain files.

Inspect/refine in the actual available Web Canvas, Web Desktop, and Electron Desktop
surfaces, and supported Web Mobile/Native Mobile. Record surface, viewport, theme,
normal/reduced motion, keyboard behavior, empty/loading/error/saving/populated states,
persistence result, and screenshot or recording evidence. A build/preflight or mock
scenario does not establish live authenticated launch or visual quality; report any
unavailable verification rather than implying it passed.

Builders invite a style, app link or inspiration screenshot when the direction is unclear. The visual-reference workflow can delegate bounded similar-app research to available subagents, inspect actual screens, and record selected patterns in the owner project's design/references/ and DESIGN.md. It keeps references out of the shared pack and verifies rendered quality separately from real Postgres persistence.

The remote Hermes installer skips any existing named skill directory or symlink before calling Hermes, since Hermes can replace filesystem-only entries even without `--force`. Use a local checkout and `sync-matrix-agent-skills.sh` to refresh Matrix-managed installations; remote repeat installs fill only missing names.

Builders choose a coherent product style from the brief, references and user’s mood. Direction affects typography, shape, borders, spacing, materials, imagery and motion as well as palette. A delegated or surprise choice is recorded once in DESIGN.md and remains stable across screens and edits. Generated products may use bright minimal, neo-brutalist, playful, retro or neumorphic art direction with readable app-local semantic colors; Matrix platform chrome/auth/billing retains the shared brand.
