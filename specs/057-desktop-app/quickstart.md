# Quickstart: 057 Desktop App Development

## Prerequisites

- Node.js 24+
- pnpm (install), bun (run scripts)
- macOS (Electron dev builds are platform-specific)
- A running Matrix OS cloud instance at `app.matrix-os.com` (or local Docker dev)

## Setup

```bash
# From repo root
cd apps/desktop

# Install dependencies (includes Electron, electron-vite)
pnpm install

# Start dev mode (hot-reload for renderer, restart for main process changes)
bun run dev
```

This launches Electron with:
- Main process watching `src/main/`
- Preload scripts watching `src/preload/`
- Renderer with Vite HMR at the dev server

## Project Layout

```
apps/desktop/
  src/main/          # Electron main process (Node.js)
  src/preload/       # Context bridge scripts (sandboxed Node.js)
  src/renderer/      # Native chrome UI (browser, bundled by Vite)
  tests/unit/        # Vitest unit tests
  tests/integration/ # Electron + Playwright integration tests
```

## Key Files

| File | Purpose |
|------|---------|
| `src/main/index.ts` | Entry point: BaseWindow, IPC registration, lifecycle |
| `src/main/tabs.ts` | WebContentsView tab manager |
| `src/main/tray.ts` | System tray menu + connection status |
| `src/main/health.ts` | Health check polling (30s interval) |
| `src/main/platform.ts` | Container management API client |
| `src/main/updater.ts` | Auto-update via GitHub Releases |
| `src/main/store.ts` | Typed electron-store schema |
| `src/preload/index.ts` | Native chrome preload (ElectronAPI) |
| `src/preload/webview-preload.ts` | WebContentsView preload (MatrixDesktopAPI) |
| `src/renderer/index.html` | App shell HTML |
| `src/renderer/sidebar.ts` | App launcher sidebar |
| `src/renderer/tab-bar.ts` | Tab bar UI |
| `src/renderer/offline.ts` | Offline overlay |

## Running Tests

```bash
# Unit tests
bun run test

# Unit tests with coverage
bun run test:coverage

# Integration tests (requires Electron binary)
bun run test:integration
```

## Building

```bash
# Dev build (unsigned)
bun run build

# Package for macOS (unsigned, local testing)
bun run package

# Full release build (signed + notarized, requires Apple certs)
bun run release
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MATRIX_OS_URL` | No | Override cloud URL (default: `https://app.matrix-os.com`) |
| `APPLE_ID` | Release only | Apple Developer account email |
| `APPLE_APP_SPECIFIC_PASSWORD` | Release only | For notarization |
| `APPLE_TEAM_ID` | Release only | Developer team ID |
| `CSC_LINK` | Release only | Base64 .p12 certificate |
| `CSC_KEY_PASSWORD` | Release only | Certificate password |
| `GH_TOKEN` | Release only | GitHub token for publishing |

## Development Workflow

1. **Run the cloud instance** (Docker dev or production) so the desktop app has something to connect to
2. **Start dev mode**: `bun run dev` — launches Electron with hot reload
3. **Write tests first** (TDD): Add failing test in `tests/unit/`, then implement in `src/main/`
4. **Test native chrome**: Changes to `src/renderer/` hot-reload via Vite
5. **Test main process**: Changes to `src/main/` trigger Electron restart

## Architecture Notes

- **No local AI**: All agent execution happens in the cloud container
- **No local state** beyond UI preferences: Tab order, window bounds, sidebar config
- **WebContentsViews** load cloud URLs (`app.matrix-os.com/?app={slug}&desktop=1`)
- **Shell detects** `?desktop=1` and hides its own chrome (sidebar, tab bar, dock)
- **Clerk auth** flows through the WebContentsView — cookies persist in Electron session
- **Health checks** every 30s — tray icon reflects connection status

## Debugging

- **Main process logs**: Terminal where `bun run dev` runs
- **Renderer DevTools**: View → Toggle Developer Tools (native chrome)
- **WebContentsView DevTools**: Right-click in tab content → Inspect (or via IPC)
- **Electron flags**: `ELECTRON_ENABLE_LOGGING=1` for verbose output
