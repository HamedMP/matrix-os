<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://matrix-os.com/rabbit-white.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://matrix-os.com/rabbit.svg">
    <img src="https://matrix-os.com/rabbit.svg" alt="Matrix OS" width="118">
  </picture>
</p>

<h1 align="center">Matrix OS</h1>

<p align="center">
  <strong>Your cloud computer for AI agents, apps, terminals, files, and integrations.</strong>
</p>

<p align="center">
  <a href="https://matrix-os.com">Website</a> ·
  <a href="https://matrix-os.com/docs">Docs</a> ·
  <a href="https://matrix-os.com/whitepaper">Whitepaper</a> ·
  <a href="https://matrix-os.com/skills.md">Agent setup</a> ·
  <a href="https://deepwiki.com/HamedMP/matrix-os">DeepWiki</a> ·
  <a href="https://discord.gg/cSBBQWtPwV">Discord</a> ·
  <a href="https://x.com/joinmatrixos">X</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg?style=for-the-badge" alt="AGPL-3.0 License"></a>
  <a href="https://matrix-os.com"><img src="https://img.shields.io/badge/Live-matrix--os.com-D06F25?style=for-the-badge" alt="matrix-os.com"></a>
  <a href="https://matrix-os.com/skills.md"><img src="https://img.shields.io/badge/Agent_Setup-skills.md-434E3F?style=for-the-badge" alt="Agent setup"></a>
  <a href="https://skills.sh/HamedMP/matrix-os"><img src="https://skills.sh/b/HamedMP/matrix-os" alt="skills.sh"></a>
  <img src="https://img.shields.io/badge/Built_with-Claude_Opus_4.6-cc785c?style=for-the-badge" alt="Built with Claude Opus 4.6">
  <img src="https://img.shields.io/badge/Tests-3,032_passing-brightgreen?style=for-the-badge" alt="3,032 tests">
</p>

Matrix OS gives you a hosted cloud computer: browser desktop, files, terminal sessions, apps, integrations, messages, and AI agents running on your personal VPS. Open any browser, sign in, and your workspace is there. Install the Matrix CLI and Claude, Codex, GitHub CLI, or Hermes can attach to the same machine.

It is not a chat box beside your software. The AI is the kernel. The shell, gateway, files, apps, terminal, channels, and agents are one operating environment.

<p align="center">
  <img src="https://matrix-os.com/images/app-screenshot.jpg" alt="Matrix OS browser desktop with generated apps" width="900">
</p>

---

## Why Matrix OS

Most AI products leave your work scattered across chats, terminals, dashboards, and local machines. Matrix OS gives agents a persistent place to work.

| You need | Matrix OS gives you |
|----------|---------------------|
| A real workspace for AI agents | A hosted personal VPS with browser shell, terminal sessions, files, apps, and logs |
| Software without waiting on a SaaS roadmap | Apps generated from natural language and saved as inspectable projects |
| Continuity across devices | One cloud desktop reachable from the web, Matrix CLI, and messaging channels |
| Data you can leave with | Owner-controlled files plus Postgres for durable app and workspace data |
| A system that can improve itself | Agents, skills, hooks, cron jobs, and self-healing workflows |

Matrix OS is the foundation for **Web 4**: a unified environment where operating system, messaging, social identity, apps, games, files, and AI agents are one system.

---

## Install Matrix OS

### Managed Matrix Cloud

Start at the landing page: [matrix-os.com](https://matrix-os.com).

Sign up or log in from there, choose a Matrix handle, provision your private runtime, and open the browser desktop. Managed Matrix OS uses a platform control plane plus one VPS-native runtime per active user. Matrix manages routing, auth, updates, backups, billing, and integrations. Your VPS is where your files, terminal sessions, generated apps, integrations, and coding agents live.

### Manual VPS Install

Run Matrix OS on an existing Linux VPS you control:

```bash
curl -fsSL https://matrix-os.com/install-server.sh | sudo bash
```

The manual installer downloads a verified host bundle, creates the `matrix` user, starts local Postgres, the Matrix gateway, web shell, code-server, nginx, and optional coding-agent tools under systemd. A domain is optional: by default nginx answers on the server IP address with Basic Auth. Manual VPS operators own DNS, TLS, backups, updates, integrations, and server security. See [Self-host docs](https://matrix-os.com/docs/self-host) for prerequisites, telemetry, and tradeoffs.

### Matrix CLI

Install the CLI:

```bash
# macOS or Linux with Homebrew
brew install finnaai/tap/matrix

# Or with npm
npm install -g @finnaai/matrix

# Or with the install script
curl -fsSL https://get.matrix-os.com | sh
```

Log in from the CLI and inspect your instance:

```bash
matrix login
matrix whoami
matrix status
matrix instance info
```

`matrix login` opens a browser/device flow against the hosted Matrix cloud. If it says no Matrix instance exists yet, sign up at [matrix-os.com](https://matrix-os.com), finish provisioning, then run `matrix login` again.

### Agent Setup

Agents should read the public skill file and follow it:

```text
https://matrix-os.com/skills.md
```

Install the skill locally if your agent runtime supports file skills:

```bash
npx skills add HamedMP/matrix-os --skill matrix-os
```

Then use Matrix shell sessions for remote work:

```bash
# Bring your own terminal agent.
matrix run -it -- claude
matrix run -it -- codex

# Use a named setup session so the web terminal and local CLI can reattach.
matrix run -it --session setup -- gh auth login
matrix run -it --session setup -- claude
matrix run -it --session setup -- codex
matrix shell attach setup
```

Detach from an interactive session with `Ctrl-\ Ctrl-\`. The remote zellij session stays alive and can be reattached from the Matrix web terminal or CLI. This is the same computer the hosted browser shell shows.

### From Source

Use the source install when contributing to Matrix OS itself:

```bash
git clone https://github.com/HamedMP/matrix-os.git
cd matrix-os

flox activate
bun run dev
```

Without Flox, install Node.js 24+, pnpm 10, and bun, then run:

```bash
pnpm install
bun run dev
```

Development services:

```bash
bun run dev:gateway    # Hono gateway
bun run dev:shell      # Next.js shell
bun run dev:proxy      # Shared API proxy
bun run dev:platform   # Multi-tenant platform
```

---

## What It Can Do

<table>
<tr><td><b>Generate apps</b></td><td>Describe a tool in plain English. Matrix creates a working app, saves it as files, and opens it in the shell.</td></tr>
<tr><td><b>Run a browser desktop</b></td><td>Canvas-first web shell with windows, dock, app launcher, wallpapers, terminal, file browser, and generated apps.</td></tr>
<tr><td><b>Keep agent work persistent</b></td><td>Projects, terminals, task context, logs, app state, and workspace state survive across sessions and devices.</td></tr>
<tr><td><b>Talk through channels</b></td><td>Reach the same kernel through web, CLI, Telegram, WhatsApp, Discord, Slack, Matrix protocol, and voice surfaces as they are enabled.</td></tr>
<tr><td><b>Connect services</b></td><td>Pipedream Connect integration for Gmail, Slack, GitHub, and 2,400+ services with OAuth-managed settings.</td></tr>
<tr><td><b>Automate on schedule</b></td><td>Cron jobs, heartbeat workflows, proactive tasks, and scheduled agent runs.</td></tr>
<tr><td><b>Heal and expand</b></td><td>Specialized agents can diagnose failures, repair files, add skills, and grow new capabilities.</td></tr>
<tr><td><b>Own your data</b></td><td>Identity and configuration are files. App and workspace data live in owner-controlled Postgres, not an opaque platform database.</td></tr>
</table>

---

## Demo

<p align="center">
  <a href="https://youtu.be/CSFIYUeOvlc">
    <img src="https://img.youtube.com/vi/CSFIYUeOvlc/maxresdefault.jpg" alt="Matrix OS demo video" width="820">
  </a>
  <br>
  <em>Watch the original Matrix OS demo.</em>
</p>

Built for the [Anthropic "Built with Opus 4.6" Hackathon](https://cv.inc/e/claude-code-hackathon) in February 2026, where Matrix OS placed in the **top 20**.

<p align="center">
  <img src="docs/images/anthropic-hackathon.jpg" alt="Matrix OS at the Claude Code Birthday Party, Anthropic HQ" width="620">
  <br>
  <em>Matrix OS at the Claude Code Birthday Party at Anthropic HQ.</em>
</p>

---

## Architecture

```text
Web shell / CLI / Telegram / WhatsApp / Discord / Slack / Matrix / Voice
                               |
                               v
                    Hono Gateway + WebSocket bus
             REST, terminal, files, messages, apps, cron, metrics
                               |
                               v
              Dispatcher -> AI Kernel (Claude Agent SDK V1)
                               |
          Builder / Researcher / Deployer / Healer / Evolver agents
                               |
                               v
       Owner-controlled files + Postgres + generated apps + integrations
```

The OS metaphor is literal:

| Computer concept | Matrix OS equivalent |
|------------------|----------------------|
| CPU | Frontier model routing, currently Claude Opus 4.6 |
| Kernel | Main Agent SDK V1 `query()` loop with `resume` |
| Processes | Specialized sub-agents with isolated context |
| Disk | Matrix home files plus owner-controlled Postgres |
| System calls | MCP and gateway IPC tools |
| Drivers | Channel adapters, integrations, browser, terminal, voice |
| Shell | Next.js desktop/canvas UI, CLI, and messaging surfaces |

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Language | TypeScript 5.5+ strict, ES modules |
| Runtime | Node.js 24+ |
| AI | Claude Agent SDK V1 `query()` + `resume`, Opus 4.6 |
| Frontend | Next.js 16, React 19, Turbopack, React Compiler |
| Backend | Hono HTTP/WebSocket gateway |
| Database | PostgreSQL via Kysely |
| Validation | Zod 4 via `zod/v4` |
| Terminal | node-pty, xterm.js, WebGL renderer |
| Integrations | Pipedream Connect |
| Observability | Prometheus metrics |
| Testing | Vitest, `@vitest/coverage-v8` |
| Package manager | pnpm for install, bun for scripts |

---

## Repository Map

```text
packages/kernel/     AI kernel, agents, hooks, SOUL, skills
packages/gateway/    Hono HTTP/WS gateway, channels, cron, terminal, voice
packages/platform/   Hosted control plane, auth, provisioning, routing
packages/proxy/      Shared API proxy and usage tracking
packages/ui/         Shared UI components
shell/               Next.js desktop and canvas shell
home/                Matrix home template copied on first boot
specs/               Architecture and feature specs
tests/               Vitest suites
docs/                Developer and operations docs
```

The public website and docs are maintained separately in the private
[`FinnaAI/matrix-os-site`](https://github.com/FinnaAI/matrix-os-site) repository.

---

## Development

Run the core checks before opening a PR:

```bash
bun run typecheck
bun run check:patterns
bun run test
```

Other useful commands:

```bash
bun run test:watch
bun run test:integration
bun run test:coverage
bun run test:e2e
```

Docker commands are available for local legacy development, but production Matrix OS is VPS-native per user. Customer runtime updates ship as host bundles, not rolling Docker image restarts.

---

## Current Status

Matrix OS is live at [matrix-os.com](https://matrix-os.com), with hosted runtime provisioning, a canvas-first shell, file browser, terminal, generated apps, onboarding, integrations, observability, docs, and the early Web 4 foundation in place.

Current focus areas:

- Paid beta readiness and production polish
- Canvas workspace and cloud coding workflows
- Mobile shell
- Matrix messaging bridge for Telegram and WhatsApp
- SDK-native skills and agent-readable setup

See:

- [Web 4 Vision](specs/web4-vision.md)
- [Matrix OS Vision](specs/matrixos-vision.md)
- [Public docs](https://matrix-os.com/docs)
- [DeepWiki](https://deepwiki.com/HamedMP/matrix-os)

---

## Community

- [Discord](https://discord.gg/cSBBQWtPwV)
- [X / Twitter](https://x.com/joinmatrixos)
- [LinkedIn](https://www.linkedin.com/company/matrix-os)
- [Agent setup skill](https://matrix-os.com/skills.md)
- [skills.sh listing](https://skills.sh/HamedMP/matrix-os)

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=HamedMP/matrix-os&type=date&legend=top-left)](https://www.star-history.com/#HamedMP/matrix-os&type=date&legend=top-left)

## License

[AGPL-3.0](LICENSE)

---

*Matrix OS. Software that does not exist until you need it. Once it does, it is yours.*
