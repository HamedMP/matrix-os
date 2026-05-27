# Quickstart: Elixir Symphony Runtime

## Local Validation

1. Build and test the adapted Elixir runtime.

   ```bash
   cd packages/symphony-elixir
   mix test
   ```

2. Start the runtime in Matrix mode.

   ```bash
   MATRIX_HOME=/home/matrix/home \
   SYMPHONY_HOST=127.0.0.1 \
   SYMPHONY_PORT=4766 \
   SYMPHONY_WORKSPACE_ROOT=/home/matrix/home/projects/matrix-os/symphony-workspaces \
   ./bin/symphony ./WORKFLOW.md
   ```

3. Run focused Matrix tests.

   ```bash
   pnpm exec vitest run tests/gateway/symphony-proxy.test.ts tests/default-apps/symphony-app.test.tsx
   pnpm exec vitest run tests/deploy/customer-vps/symphony-systemd.test.ts
   ```

4. Build the host bundle and verify `matrix-symphony.service` is included.

   ```bash
   set -a; source .env; set +a
   ./scripts/build-host-bundle.sh
   ```

## VPS Verification

1. Confirm the service is installed and loopback-bound.

   ```bash
   systemctl status matrix-symphony.service
   curl -fsS http://127.0.0.1:4766/api/v1/state
   ```

2. Confirm Matrix gateway proxy works.

   ```bash
   curl -fsS http://127.0.0.1:3001/api/symphony/state
   ```

3. Open the Matrix Symphony app and verify the active issue, session ID, turn count, logs, workpad link, workspace path, refresh, and stop actions.
