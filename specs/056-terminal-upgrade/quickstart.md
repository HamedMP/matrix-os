# Quickstart: Terminal Upgrade (Spec 056)

## Prerequisites

- Node.js 24+
- pnpm installed
- Matrix OS repo cloned with deps: `pnpm install`

## Install new dependencies

```bash
# Frontend xterm addons
cd shell && pnpm add @xterm/addon-webgl @xterm/addon-search @xterm/addon-serialize && cd ..
```

No new backend dependencies needed (node-pty already present).

## Run tests

```bash
# All unit tests
bun run test

# Specific test files (during development)
bunx vitest run tests/gateway/ring-buffer.test.ts
bunx vitest run tests/gateway/session-registry.test.ts
bunx vitest run tests/gateway/terminal-ws.test.ts
bunx vitest run tests/shell/terminal-cache.test.ts
bunx vitest run tests/shell/terminal-themes.test.ts
bunx vitest run tests/shell/web-link-provider.test.ts
```

## Run dev server

```bash
bun run dev    # gateway :4000 + shell :3000
```

## Docker dev

```bash
bun run docker  # Primary development mode (requires OrbStack on macOS)
```

## Verify manually

1. Open terminal at `localhost:3000`, open Terminal app
2. Run a command (e.g. `ls -la`)
3. Refresh browser — scrollback should be preserved
4. Switch tabs — switching should be instant (no flicker)
5. `Ctrl+Shift+F` — search bar should appear
6. Click a URL in terminal output — should open in new tab
7. `Ctrl+Shift+C/V` — copy/paste should work

## Implementation order

The spec defines 5 phases. Each phase is independently testable:

1. **Phase 1**: RingBuffer + SessionRegistry (backend) — PTY survives WS disconnect
2. **Phase 2**: Terminal cache + session reattach (frontend) — scrollback survives refresh
3. **Phase 3**: WebGL rendering — faster output rendering
4. **Phase 4**: Terminal search — Ctrl+Shift+F
5. **Phase 5**: Themes + links + copy/paste + serialize addon
