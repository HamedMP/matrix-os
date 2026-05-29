# Matrix-adapted Elixir Symphony

This package is the Matrix OS adaptation point for the upstream Elixir Symphony runtime from `https://github.com/odysseus0/symphony`.

The runtime is packaged into customer VPS host bundles and started by `matrix-symphony.service` as the `matrix` user with `MATRIX_HOME=/home/matrix/home`. Matrix gateway remains the browser-facing control plane and proxies `/api/symphony/*` to the loopback Elixir API.

The source is imported without vendored `deps/` or `_build/` output. Matrix-specific adaptation starts at `WORKFLOW.md`, `lib/symphony_elixir/config/schema.ex`, and the customer VPS wrapper/service files.
