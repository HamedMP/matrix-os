# Matrix-adapted Elixir Symphony

This package is the Matrix OS adaptation point for the upstream Elixir Symphony runtime from `https://github.com/odysseus0/symphony`.

The runtime is packaged into customer VPS host bundles and started by `matrix-symphony.service` as the `matrix` user with `MATRIX_HOME=/home/matrix/home`. Matrix gateway remains the browser-facing control plane and proxies `/api/symphony/*` to the loopback Elixir API.

The full adapted source is added in the runtime packaging stack. This scaffold pins the package location, service contract, and license boundary so stack layers can stay reviewable.
