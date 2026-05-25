# Implementation Plan: Elixir Symphony Runtime

**Branch**: `083-elixir-symphony` | **Date**: 2026-05-25 | **Spec**: `specs/083-elixir-symphony/spec.md`  
**Input**: Feature specification from `/specs/083-elixir-symphony/spec.md`

## Summary

Replace Matrix's duplicate TypeScript Symphony orchestration path with an adapted Elixir Symphony runtime packaged into the customer VPS host bundle. The Elixir runtime runs as `matrix-symphony.service`, uses Matrix-owned workspace roots and Linear credential bridging, executes agents through `codex app-server`, and exposes loopback HTTP state/control. Matrix gateway proxies `/api/symphony/*` with auth, validation, timeouts, and generic error mapping. The Matrix Symphony app becomes a responsive UI shell over normalized Elixir state.

## Technical Context

**Language/Version**: TypeScript 5.5+ strict, Node.js 24+, React 19, Hono gateway, Elixir `~> 1.19` for adapted Symphony runtime  
**Primary Dependencies**: Existing Matrix gateway/app stack, upstream Elixir Symphony Phoenix/Bandit/Req/Jason runtime, systemd host services, Codex `app-server`  
**Storage**: Owner-controlled Matrix home files for runtime config and workspaces; Matrix platform/Pipedream integration storage for Linear secrets; no new embedded database  
**Testing**: Vitest for gateway/app/systemd; Elixir `mix test` for adapted runtime when toolchain is available; host-bundle smoke tests  
**Target Platform**: Customer VPS Linux host services, Matrix web app, Matrix gateway  
**Project Type**: Multi-surface runtime: host service + gateway API + Vite app + docs  
**Performance Goals**: Gateway proxy state/control responses timeout within 10 seconds; browser-visible logs bounded; no duplicate active ticket state between TS and Elixir runtimes  
**Constraints**: Loopback-only Elixir API; no browser-visible secrets; Matrix auth gates all browser calls; workspaces remain under owner home; Codex execution uses app-server  
**Scale/Scope**: One Symphony service per customer VPS, bounded active/completed runs, one workspace per active issue

## Constitution Check

- **Data Belongs to Its Owner**: PASS. Runtime config/workspaces live under owner home; provider secrets stay in Matrix integration storage.
- **AI Is the Kernel**: PASS WITH ADAPTER. Codex app-server becomes the execution protocol for coding agents; this is compatible with Matrix kernel direction.
- **Headless Core, Multi-Shell**: PASS. Symphony runs headlessly as a service; Matrix app is one shell.
- **Defense in Depth**: PASS REQUIRED. Spec includes auth matrix, route validation, loopback proxy constraint, timeout policy, generic error policy, and resource caps.
- **TDD**: PASS REQUIRED. Tasks require tests before implementation for service packaging, gateway proxy, credential bridge, and app UI.
- **Documentation-Driven Development**: PASS REQUIRED. Public docs update is part of the stack.

## Project Structure

```text
specs/083-elixir-symphony/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── gateway-symphony-api.md
└── tasks.md

distro/customer-vps/systemd/
└── matrix-symphony.service

packages/gateway/src/symphony/
├── proxy.ts
├── proxy-contracts.ts
└── credential-bridge.ts

packages/gateway/src/symphony-routes.ts
home/apps/symphony/src/App.tsx
home/apps/symphony/src/*
tests/gateway/*
tests/deploy/customer-vps/*
tests/default-apps/*
www/content/docs/symphony.mdx
```

**Structure Decision**: Keep Matrix-owned browser/API integration in TypeScript and host-runtime orchestration in an adapted Elixir source tree. The exact Elixir source location will be selected during implementation after checking host-bundle packaging constraints; likely candidates are `packages/symphony-elixir/` or `distro/customer-vps/symphony/`.

## Stack Plan

- **Stack 1 - Spec and packaging contract**: Add this spec/plan/tasks/contracts, choose Elixir source location, add license/notice handling, and add failing host-bundle/systemd tests.
- **Stack 2 - Elixir runtime packaging**: Vendor/adapt Elixir Symphony runtime, add `matrix-symphony.service`, host-bundle packaging, loopback config, owner-home workspace defaults, and runtime tests.
- **Stack 3 - Gateway proxy and credential bridge**: Replace `/api/symphony/*` with Matrix-authenticated proxy routes, Zod contracts, timeout/error mapping, and Matrix Linear credential bridge.
- **Stack 4 - Matrix app shell**: Update `home/apps/symphony` to render Elixir state/session/turn/log/workpad/workspace/actions responsively.
- **Stack 5 - Retirement and docs**: Disable/remove TypeScript orchestrator/run table, update public docs, run full validation, and monitor stacked PR CI/reviews/Greptile until 5/5.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --- | --- | --- |
| Second runtime language in customer host bundle | User explicitly wants the Elixir Symphony implementation for app-server lifecycle semantics | Reimplementing app-server orchestration in TypeScript repeats the confusing current direction and loses upstream alignment |
