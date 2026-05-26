import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("customer VPS Symphony systemd unit", () => {
  it("runs Elixir Symphony as a Matrix-owned loopback service", async () => {
    const unit = await readFile("distro/customer-vps/systemd/matrix-symphony.service", "utf8");
    const wrapper = await readFile("distro/customer-vps/host-bin/matrix-symphony", "utf8");
    const buildScript = await readFile("scripts/build-host-bundle.sh", "utf8");

    expect(unit).toContain("Description=Matrix OS customer Symphony");
    expect(unit).toContain("User=matrix");
    expect(unit).toContain("Group=matrix");
    expect(unit).toContain("Environment=MATRIX_HOME=/home/matrix/home");
    expect(unit).toContain("Environment=SYMPHONY_HOST=127.0.0.1");
    expect(unit).toContain("Environment=SYMPHONY_PORT=4766");
    expect(unit).toContain("Environment=SYMPHONY_WORKSPACE_ROOT=/home/matrix/home/projects/matrix-os/symphony-workspaces");
    expect(unit).toContain("ExecStart=/opt/matrix/bin/matrix-symphony");
    expect(unit).not.toContain("EnvironmentFile=/opt/matrix/env/host.env");
    expect(unit).toContain("KillMode=mixed");
    expect(unit).toContain("KillSignal=SIGTERM");
    expect(unit).toContain("TimeoutStopSec=30");
    expect(unit).toContain("ConditionPathExists=/opt/matrix/app/packages/symphony-elixir/bin/symphony");

    expect(wrapper).toContain("source /opt/matrix/env/host.env");
    expect(wrapper).toContain("export MATRIX_HOME=\"${MATRIX_HOME:-/home/matrix/home}\"");
    expect(wrapper).toContain("export SYMPHONY_HOST=\"${SYMPHONY_HOST:-127.0.0.1}\"");
    expect(wrapper).toContain("export SYMPHONY_PORT=\"${SYMPHONY_PORT:-4766}\"");
    expect(wrapper).toContain("export SYMPHONY_WORKSPACE_ROOT=\"${SYMPHONY_WORKSPACE_ROOT:-$MATRIX_HOME/projects/matrix-os/symphony-workspaces}\"");
    expect(wrapper).toContain("exec \"$SYMPHONY_BIN\" \"$WORKFLOW_FILE\"");

    expect(buildScript).toContain("\"$STAGE_DIR/bin/matrix-symphony\"");
  });

  it("packages the adapted Elixir Symphony source and license in the host bundle app tree", async () => {
    const license = await readFile("packages/symphony-elixir/LICENSE", "utf8");
    const notice = await readFile("packages/symphony-elixir/NOTICE", "utf8");
    const readme = await readFile("packages/symphony-elixir/README.md", "utf8");
    const buildScript = await readFile("scripts/build-host-bundle.sh", "utf8");

    expect(license).toContain("Apache License");
    expect(notice).toContain("Matrix-adapted Elixir Symphony");
    expect(notice).toContain("Copyright 2026 Matrix OS contributors");
    expect(readme).toContain("Matrix-adapted Elixir Symphony");
    expect(buildScript).toContain("cp -a \"$ROOT_DIR/packages\" \"$STAGE_DIR/app/packages\"");
  });

  it("keeps observability failures distinct from missing issues", async () => {
    const presenter = await readFile("packages/symphony-elixir/lib/symphony_elixir_web/presenter.ex", "utf8");
    const controller = await readFile("packages/symphony-elixir/lib/symphony_elixir_web/controllers/observability_api_controller.ex", "utf8");
    const pubsub = await readFile("packages/symphony-elixir/lib/symphony_elixir_web/observability_pubsub.ex", "utf8");
    const staticAssets = await readFile(
      "packages/symphony-elixir/lib/symphony_elixir_web/controllers/static_asset_controller.ex",
      "utf8",
    );

    expect(presenter).toContain("{:error, :snapshot_timeout}");
    expect(presenter).toContain("{:error, :snapshot_unavailable}");
    expect(presenter).toContain("DateTime.add(due_in_ms, :millisecond)");
    expect(controller).toContain("orchestrator_timeout");
    expect(controller).toContain("orchestrator_unavailable");
    expect(controller).toContain('code: "snapshot_timeout"');
    expect(controller).toContain("put_status(503)");
    expect(pubsub).toContain("_ = Phoenix.PubSub.broadcast");
    expect(pubsub).toContain(":ok");
    const dashboardLive = await readFile("packages/symphony-elixir/lib/symphony_elixir_web/live/dashboard_live.ex", "utf8");
    expect(dashboardLive).toContain("_ = ObservabilityPubSub.subscribe()");
    expect(dashboardLive).not.toContain(":ok = ObservabilityPubSub.subscribe()");
    expect(staticAssets).toContain('put_resp_header("cache-control", "no-cache")');
    expect(staticAssets).not.toContain("max-age=31536000");
  });
});
