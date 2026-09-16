# DOMAIN: `terminal` — terminal runtime surfaces (PTY/Zellij adapters, routes)

Owns everything between the WS layer and the PTY: adapters, session
routes, input capabilities, systemd/zellij lifecycle. The WS handlers
themselves stay in `server.ts` until Phase 5 defines the single session
owner. May import `sessions` (session registry), `workspace`, `_shared`.

## Contents

`pty.ts` · `zellij-runtime.ts` · `terminal-debug.ts` · `terminal-env.ts` ·
`terminal-input-capabilities.ts` · `terminal-output-compat.ts` ·
`terminal-session-routes.ts` · `terminal-user-systemd-activation.ts` ·
`user-systemd-zellij-runtime.ts`

## Decision log

- 2026-09-16 (Phase 1-A3/W3): new domain resolving Spec 093 open question
  2 — `pty`/`zellij-runtime` are a terminal runtime, neither sessions nor
  workspace. WS upgrade handlers deliberately NOT moved (see `server.ts`
  realtime-core note; Phase 5).
