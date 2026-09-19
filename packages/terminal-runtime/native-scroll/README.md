# Native Zellij scroll bridge

This first-party WASI plugin queries native history geometry and seeks within the same buffer that receives mouse-wheel input. It returns row counts, never terminal text, using the runtime's pinned Zellij 0.44.3 API.

Rebuild with Rust/rustup installed:

```sh
node packages/terminal-runtime/native-scroll/build.mjs
```

The pinned toolchain and locked Cargo dependencies build `../assets/scroll-v1.wasm`; `manifest.json` records source and artifact hashes checked by a unit test. Cargo output uses a temporary target directory removed on success or failure. The host bundle includes the package and shipped asset; production does not compile Rust.

The runtime appends this plugin's ReadPaneContents, ReadCliPipes and ChangeApplicationState grants while preserving other owner grants. Cache paths outside the owner home and symlinked cache parents/files are rejected. A cold plugin can return unavailable during initialization; the runtime retries after its bounded failure cache. Metrics queries never block the socket input queue. Native seeks are serialized with terminal mutations and require the live writer lease.

Queries have a 3-second timeout and 512-byte response limit. Replies allow at most 100,000 history rows and 200 viewport rows. Each seek uses at most 256 actions; the UI coalesces drags and continues toward its latest target using the returned position. Unsupported/failed native queries retain local rail behavior.

Run real native validation against a matching official Zellij executable:

```sh
MATRIX_TEST_ZELLIJ_BIN=/absolute/path/to/zellij TMPDIR=/tmp pnpm exec vitest run --config vitest.integration.config.ts tests/terminal-runtime/native-scroll.integration.ts
```

The test uses an isolated temporary owner home/session, real PTY mouse reporting, absolute seeks and output appended while viewing history, then deletes its resources.
