# Implementation Plan: Desktop App — Native Cloud Client

**Branch**: `057-desktop-app` | **Date**: 2026-04-03 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/057-desktop-app/spec.md`

## Summary

A native macOS Electron app that connects to the user's cloud Matrix OS instance at `app.matrix-os.com`. Uses BaseWindow + WebContentsView (Electron 41+) for a tabbed interface with native sidebar, system tray, container management, and auto-update via GitHub Releases. The cloud shell renders inside managed WebContentsViews — the desktop app provides the chrome (sidebar, tab bar, tray) while the shell provides the content.

## Technical Context

**Language/Version**: TypeScript 5.5+ strict, ES modules
**Primary Dependencies**: Electron 41.x, electron-vite 5.0.x, electron-builder 26.8.x, electron-updater 6.x, electron-store 10.x
**Storage**: electron-store (JSON config file, ~100KB) for tab persistence, sidebar order, window bounds, preferences
**Testing**: Vitest for unit tests (tab manager, platform client, tray logic). Electron integration tests with Playwright Electron support.
**Target Platform**: macOS (universal binary: Intel + Apple Silicon). Windows/Linux deferred.
**Project Type**: Electron app within existing monorepo (`apps/desktop/`)
**Performance Goals**: <200ms tab switch, <5s cold start, <100MB idle RAM
**Constraints**: No local AI execution, no file sync, no custom renderer. Cloud-only client.
**Scale/Scope**: Single-user desktop client, max 20 concurrent tabs

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Everything Is a File | PASS | Desktop app is a client — all state lives in the cloud filesystem. Local persistence (electron-store) is only for UI state (tab order, window bounds). |
| II. Agent Is the Kernel | PASS | No local agent. All AI runs in the cloud container. Desktop app routes through the same gateway. |
| III. Headless Core, Multi-Shell | PASS | Desktop app is another shell renderer, like the browser. Core is headless, desktop app connects via the same HTTP/WS gateway. Shell detects `?desktop=1` for embedded mode. |
| IV. Self-Healing | PASS | Health check polling (30s), auto-reconnect on network recovery, session reattachment via spec 056. |
| V. Simplicity | PASS | No local AI, no file sync, no custom renderer. WebContentsViews load the existing cloud shell. electron-vite for builds. Minimal native chrome. |
| VII. Defense in Depth | PASS | Context isolation enabled, sandbox enabled, no nodeIntegration in renderer, URL restricted to `*.matrix-os.com`, IPC bridge is minimal typed API, Clerk session cookie for auth. |
| VIII. TDD | PASS | Unit tests for tab manager, platform client, tray, updater. Integration tests for auth flow, tab lifecycle, container management. |

No violations. No complexity justification needed.

## Project Structure

### Documentation (this feature)

```text
specs/057-desktop-app/
├── spec.md              # Feature specification
├── plan.md              # This file
├── research.md          # Phase 0: technology research
├── data-model.md        # Phase 1: data models and types
├── contracts/           # Phase 1: API contracts
│   ├── ipc-bridge.ts    # IPC channel definitions
│   └── gateway-container.yaml  # New gateway container management endpoints
└── quickstart.md        # Phase 1: dev setup guide
```

### Source Code (repository root)

```text
apps/desktop/
├── src/
│   ├── main/
│   │   ├── index.ts            # Entry: BaseWindow, IPC registration, lifecycle
│   │   ├── tabs.ts             # Tab/WebContentsView management
│   │   ├── tray.ts             # System tray + menu
│   │   ├── updater.ts          # Auto-update via electron-updater
│   │   ├── platform.ts         # Platform API client (container management)
│   │   ├── health.ts           # Health check polling + state machine
│   │   └── store.ts            # electron-store typed schema
│   ├── preload/
│   │   └── index.ts            # Context bridge: matrixDesktop API
│   └── renderer/
│       ├── index.html          # App shell
│       ├── index.ts            # Renderer entry
│       ├── sidebar.ts          # App launcher sidebar component
│       ├── tab-bar.ts          # Tab bar UI component
│       └── offline.ts          # Offline overlay screen
├── tests/
│   ├── unit/
│   │   ├── tabs.test.ts
│   │   ├── platform.test.ts
│   │   ├── tray.test.ts
│   │   ├── health.test.ts
│   │   └── updater.test.ts
│   └── integration/
│       ├── auth.integration.test.ts
│       ├── tabs.integration.test.ts
│       └── container.integration.test.ts
├── build/
│   ├── icon.icns
│   └── entitlements.mac.plist
├── electron.vite.config.ts
├── electron-builder.yml
├── package.json
├── tsconfig.json
└── tsconfig.node.json

packages/gateway/src/
├── container-routes.ts         # NEW: /api/container/* proxy endpoints
└── server.ts                   # MODIFY: mount container routes

shell/src/
├── hooks/use-desktop-mode.ts   # NEW: detect ?desktop=1, hide shell chrome
└── components/Desktop.tsx      # MODIFY: respect embedded mode
```

**Structure Decision**: New `apps/desktop/` package in the existing monorepo. Gateway gets 4 new proxy endpoints. Shell gets embedded mode detection. No new packages outside these locations.
