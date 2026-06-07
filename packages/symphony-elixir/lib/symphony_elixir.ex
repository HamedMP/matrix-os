defmodule SymphonyElixir do
  @moduledoc """
  Entry point for the Symphony orchestrator.
  """

  @doc """
  Start the orchestrator in the current BEAM node.
  """
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    SymphonyElixir.Orchestrator.start_link(opts)
  end
end

defmodule SymphonyElixir.Application do
  @moduledoc """
  OTP application entrypoint that starts core supervisors and workers.
  """

  use Application

  @impl true
  def start(_type, _args) do
    configure_from_env()
    :ok = SymphonyElixir.LogFile.configure()

    children = [
      {Phoenix.PubSub, name: SymphonyElixir.PubSub},
      {Task.Supervisor, name: SymphonyElixir.TaskSupervisor},
      SymphonyElixir.WorkflowStore,
      SymphonyElixir.Orchestrator,
      SymphonyElixir.HttpServer,
      SymphonyElixir.StatusDashboard
    ]

    Supervisor.start_link(
      children,
      strategy: :one_for_one,
      name: SymphonyElixir.Supervisor
    )
  end

  @impl true
  def stop(_state) do
    SymphonyElixir.StatusDashboard.render_offline_status()
    :ok
  end

  defp configure_from_env do
    case System.get_env("SYMPHONY_WORKFLOW_FILE") do
      path when is_binary(path) and path != "" ->
        SymphonyElixir.Workflow.set_workflow_file_path(Path.expand(path))

      _ ->
        :ok
    end

    case System.get_env("SYMPHONY_LOGS_ROOT") do
      path when is_binary(path) and path != "" ->
        Application.put_env(:symphony_elixir, :log_file, SymphonyElixir.LogFile.default_log_file(Path.expand(path)))

      _ ->
        :ok
    end

    case System.get_env("SYMPHONY_PORT") do
      port when is_binary(port) ->
        case Integer.parse(port) do
          {value, ""} when value >= 0 -> Application.put_env(:symphony_elixir, :server_port_override, value)
          _ -> :ok
        end

      _ ->
        :ok
    end
  end
end
