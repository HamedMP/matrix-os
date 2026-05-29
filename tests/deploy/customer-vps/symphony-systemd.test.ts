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
    expect(wrapper).toContain("--i-understand-that-this-will-be-running-without-the-usual-guardrails");
    expect(wrapper).toContain("--logs-root \"$MATRIX_HOME/system/symphony/logs\"");
    expect(wrapper).toContain("--port \"$SYMPHONY_PORT\"");
    expect(wrapper).toContain("\"$WORKFLOW_FILE\"");

    expect(buildScript).toContain("\"$STAGE_DIR/bin/matrix-symphony\"");
  });

  it("provisions Erlang runtime and enables Symphony during customer VPS bootstrap", async () => {
    const cloudInit = await readFile("distro/customer-vps/cloud-init.yaml", "utf8");

    expect(cloudInit).toContain("erlang-base");
    expect(cloudInit).toContain("erlang-ssl");
    expect(cloudInit).toContain("matrix-symphony");
    expect(cloudInit).toContain("systemctl enable matrix-restore.service matrix-gateway.service matrix-shell.service matrix-code.service matrix-sync-agent.service matrix-symphony.service");
    expect(cloudInit).toContain("systemctl start matrix-restore.service matrix-gateway.service matrix-shell.service matrix-code.service matrix-sync-agent.service matrix-symphony.service");
  });

  it("packages the adapted Elixir Symphony source and license in the host bundle app tree", async () => {
    const license = await readFile("packages/symphony-elixir/LICENSE", "utf8");
    const notice = await readFile("packages/symphony-elixir/NOTICE", "utf8");
    const readme = await readFile("packages/symphony-elixir/README.md", "utf8");
    const mix = await readFile("packages/symphony-elixir/mix.exs", "utf8");
    const workflow = await readFile("packages/symphony-elixir/WORKFLOW.md", "utf8");
    const configSchema = await readFile("packages/symphony-elixir/lib/symphony_elixir/config/schema.ex", "utf8");
    const linearBridge = await readFile("packages/symphony-elixir/lib/symphony_elixir/linear/bridge.ex", "utf8");
    const buildScript = await readFile("scripts/build-host-bundle.sh", "utf8");

    expect(license).toContain("Apache License");
    expect(notice).toContain("Matrix-adapted Elixir Symphony");
    expect(notice).toContain("Copyright 2026 Matrix OS contributors");
    expect(readme).toContain("Matrix-adapted Elixir Symphony");
    expect(mix).toContain("app: :symphony_elixir");
    expect(workflow).toContain('root: "$SYMPHONY_WORKSPACE_ROOT"');
    expect(workflow).toContain('command: "$SYMPHONY_CODEX_COMMAND"');
    expect(workflow).toContain('host: "127.0.0.1"');
    expect(configSchema).toContain("SYMPHONY_WORKSPACE_ROOT");
    expect(configSchema).toContain("MATRIX_HOME");
    expect(configSchema).toContain("SYMPHONY_LINEAR_CREDENTIAL");
    expect(configSchema).toContain("Bridge.credential()");
    expect(linearBridge).toContain("matrixos:integration:linear");
    expect(configSchema).toContain("SYMPHONY_LINEAR_API_KEY");
    expect(configSchema).toContain("SYMPHONY_LINEAR_PROJECT_SLUG");
    expect(buildScript).toContain("cp -a \"$ROOT_DIR/packages\" \"$STAGE_DIR/app/packages\"");
  });

  it("keeps observability failures distinct from missing issues", async () => {
    const presenter = await readFile("packages/symphony-elixir/lib/symphony_elixir_web/presenter.ex", "utf8");
    const controller = await readFile("packages/symphony-elixir/lib/symphony_elixir_web/controllers/observability_api_controller.ex", "utf8");
    const router = await readFile("packages/symphony-elixir/lib/symphony_elixir_web/router.ex", "utf8");
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
    expect(router).toContain('post("/api/v1/runs/:issue_identifier/stop"');
    expect(router).not.toContain('post("/api/v1/:issue_identifier/stop"');
    expect(pubsub).toContain("_ = Phoenix.PubSub.broadcast");
    expect(pubsub).toContain(":ok");
    const dashboardLive = await readFile("packages/symphony-elixir/lib/symphony_elixir_web/live/dashboard_live.ex", "utf8");
    expect(dashboardLive).toContain("_ = ObservabilityPubSub.subscribe()");
    expect(dashboardLive).not.toContain(":ok = ObservabilityPubSub.subscribe()");
    expect(staticAssets).toContain('put_resp_header("cache-control", "no-cache")');
    expect(staticAssets).not.toContain("max-age=31536000");
  });

  it("keeps terminal status dashboard rendering stable", async () => {
    const statusDashboard = await readFile("packages/symphony-elixir/lib/symphony_elixir/status_dashboard.ex", "utf8");

    expect(statusDashboard).toContain("def handle_info(:tick, state)");
    expect(statusDashboard).toContain("schedule_tick(state.refresh_ms)");
    expect(statusDashboard).toContain("Throughput graph:");
    expect(statusDashboard).toContain("|> Enum.map(&format_retry_summary/1)");
    expect(statusDashboard).toMatch(/catch\s*:exit,\s*_reason\s*->\s*:error/);
    expect(statusDashboard).toContain("defp tps_graph(samples, now_ms, _current_tokens)");
    expect(statusDashboard).toMatch(/samples\s*\|>\s*prune_graph_samples\(now_ms\)/);
    expect(statusDashboard).toContain("String.length(value) <= width");
    expect(statusDashboard).toContain("when String.length(value) > max");
    expect(statusDashboard).not.toContain('Enum.map_join(", ", &format_retry_summary/1)');
    expect(statusDashboard).not.toContain("when byte_size(value) > max");
    expect(statusDashboard).toContain("String.trim_trailing");
  });

  it("keeps Codex dynamic tools inside the workspace and bounded on Linear calls", async () => {
    const appServer = await readFile("packages/symphony-elixir/lib/symphony_elixir/codex/app_server.ex", "utf8");
    const dynamicTool = await readFile("packages/symphony-elixir/lib/symphony_elixir/codex/dynamic_tool.ex", "utf8");
    const linearClient = await readFile("packages/symphony-elixir/lib/symphony_elixir/linear/client.ex", "utf8");

    expect(appServer).toContain("DynamicTool.execute(tool, arguments, workspace: workspace)");
    expect(appServer).toContain("issue_value(issue, :identifier)");
    expect(appServer).toContain("issue_id = issue_value(issue, :id)");
    expect(appServer).toContain('Map.get(issue, Atom.to_string(key))');
    expect(dynamicTool).toContain("resolve_workpad_path");
    expect(dynamicTool).toContain("File.realpath(expanded_root)");
    expect(dynamicTool).toContain("file path must stay inside the workspace");
    expect(linearClient).toContain("receive_timeout: 30_000");
    expect(linearClient).toContain("@max_pages 200");
    expect(linearClient).toContain("Linear pagination hit the #{@max_pages}-page limit");
    expect(linearClient).toContain("{:ok, issues, %{has_next_page: false, end_cursor: nil}}");
  });

  it("keeps orchestrator state bounded and callback annotations explicit", async () => {
    const orchestrator = await readFile("packages/symphony-elixir/lib/symphony_elixir/orchestrator.ex", "utf8");

    expect(orchestrator).not.toContain("completed: MapSet.new()");
    expect(orchestrator).not.toContain("completed: MapSet.put");
    expect(orchestrator).toContain("@impl true");
    expect(orchestrator).toContain("def handle_call(:snapshot");
    expect(orchestrator).toContain("def handle_call(:request_refresh");
    expect(orchestrator).toContain("Process.cancel_timer(state.tick_timer_ref)");
    expect(orchestrator).toContain("if state.poll_check_in_progress do");
    expect(orchestrator).toContain("cleanup_issue_workspace(Map.get(metadata, :identifier))");
    expect(orchestrator).toContain("state = %{state | claimed: MapSet.put(state.claimed, issue.id)}");
    expect(orchestrator).toContain("defp retry_delay(_attempt, _metadata), do: @failure_retry_base_ms");
  });

  it("uses Matrix-owned repository and runtime endpoint secrets", async () => {
    const beforeRemove = await readFile("packages/symphony-elixir/lib/mix/tasks/workspace.before_remove.ex", "utf8");
    const config = await readFile("packages/symphony-elixir/config/config.exs", "utf8");
    const configSchema = await readFile("packages/symphony-elixir/lib/symphony_elixir/config/schema.ex", "utf8");
    const pathSafety = await readFile("packages/symphony-elixir/lib/symphony_elixir/path_safety.ex", "utf8");
    const prBodyCheck = await readFile("packages/symphony-elixir/lib/mix/tasks/pr_body.check.ex", "utf8");
    const workflow = await readFile("packages/symphony-elixir/WORKFLOW.md", "utf8");
    const workspace = await readFile("packages/symphony-elixir/lib/symphony_elixir/workspace.ex", "utf8");
    const workflowStore = await readFile("packages/symphony-elixir/lib/symphony_elixir/workflow_store.ex", "utf8");
    const promptBuilder = await readFile("packages/symphony-elixir/lib/symphony_elixir/prompt_builder.ex", "utf8");
    const agentRunner = await readFile("packages/symphony-elixir/lib/symphony_elixir/agent_runner.ex", "utf8");
    const runtimeConfig = await readFile("packages/symphony-elixir/lib/symphony_elixir/config.ex", "utf8");
    const httpServer = await readFile("packages/symphony-elixir/lib/symphony_elixir/http_server.ex", "utf8");

    expect(beforeRemove).toContain('@default_repo "HamedMP/matrix-os"');
    expect(beforeRemove).not.toContain("openai/symphony");
    expect(config).toContain('System.get_env("SYMPHONY_SECRET_KEY_BASE")');
    expect(config).toContain(":crypto.strong_rand_bytes");
    expect(config).toContain('check_origin: ["//localhost", "//127.0.0.1", "//[::1]"]');
    expect(config).not.toContain('secret_key_base: String.duplicate("s", 64)');
    expect(config).not.toContain("check_origin: false");
    expect(pathSafety).toContain("@max_symlink_hops 40");
    expect(pathSafety).toContain("{:error, :eloop}");
    expect(prBodyCheck).toContain("~r/^\\#{2,6}\\s+.+$/m");
    expect(prBodyCheck).not.toContain("~r/^\\#{4,6}\\s+.+$/m");
    expect(workflow).not.toContain("danger-full-access");
    expect(workflow).not.toContain("dangerFullAccess");
    expect(workspace).toContain("Workspace removal failed");
    expect(workspace).toContain("Workspace issue cleanup failed");
    expect(workspace).toContain("Workspace before_run hook setup failed");
    expect(workspace).toContain("Workspace after_run hook setup failed");
    expect(workspace).toContain("{:workspace_path_not_directory, workspace}");
    expect(workspace).toContain('Logger.error("Workspace removal failed path=#{workspace} error=#{Exception.message(error)}")');
    expect(workflowStore).toContain("{:ok, new_state.workflow, {:stale, reason}}");
    expect(workflowStore).toContain("File.stat(path)");
    expect(workflowStore).not.toContain("File.read(path)");
    expect(promptBuilder).toContain("{:error, {:workflow_unavailable, reason}}");
    expect(promptBuilder).toContain("{:error, {:stale_workflow, reason}}");
    expect(agentRunner).toContain("{:ok, prompt} <- build_turn_prompt");
    expect(agentRunner).toContain("with {:ok, max_turns} <- max_turns(opts)");
    expect(agentRunner).toContain("err in ArgumentError -> {:error, {:config_unavailable, Exception.message(err)}}");
    expect(runtimeConfig).toContain("case settings() do");
    expect(runtimeConfig).toContain("log_config_fallback(\"server_port\", reason)");
    expect(runtimeConfig).toContain("@fallback_max_concurrent_agents 1");
    expect(httpServer).toContain("with {:ok, %{host: host, port: port}} <- server_options(opts) do");
    expect(httpServer).toContain("{:error, {:config_unavailable, reason}}");
    expect(configSchema).toContain('"excludeTmpdirEnvVar" => true');
    expect(configSchema).toContain('"excludeSlashTmp" => true');
    expect(workflow).toContain("Host read-only access is intentional");
    expect(prBodyCheck).toContain("skip_heading_newlines(doc, section_start)");
    expect(prBodyCheck).toContain("|> Enum.drop_while(&(&1 != current_heading))");
    expect(prBodyCheck).toContain("|> Enum.drop(1)");
    expect(prBodyCheck).not.toContain('"\n\n" <- binary_part(doc, section_start, 2)');
  });

  it("routes Linear through the Matrix-owned integration bridge by default", async () => {
    const linearClient = await readFile("packages/symphony-elixir/lib/symphony_elixir/linear/client.ex", "utf8");
    const presenter = await readFile("packages/symphony-elixir/lib/symphony_elixir_web/presenter.ex", "utf8");

    expect(linearClient).toContain("Bridge.credential()");
    expect(presenter).toContain("is_binary(settings.tracker.api_key) and settings.tracker.api_key == Bridge.credential()");
    expect(linearClient).toContain("PLATFORM_INTERNAL_URL");
    expect(linearClient).toContain("UPGRADE_TOKEN");
    expect(linearClient).toContain("MATRIX_HANDLE");
    expect(linearClient).toContain("/internal/containers/");
    expect(linearClient).toContain("/integrations/call");
    expect(linearClient).toContain("URI.encode(handle, &URI.char_unreserved?/1)");
    expect(linearClient).not.toContain("URI.encode_www_form(handle)");
    expect(linearClient).toContain('service: "linear"');
    expect(linearClient).toContain('action: "graphql"');
    expect(linearClient).toContain(":matrix_linear_bridge_error");
  });
});
