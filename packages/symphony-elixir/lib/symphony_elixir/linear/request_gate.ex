defmodule SymphonyElixir.Linear.RequestGate do
  @moduledoc "One shared circuit for polls, reconciliation, cleanup and agent Linear calls."
  use GenServer
  require Logger
  alias SymphonyElixir.PollingPolicy

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  def checkout(server \\ __MODULE__, fingerprint),
    do: GenServer.call(server, {:checkout, fingerprint})

  def finish(server \\ __MODULE__, lease, result),
    do: GenServer.call(server, {:finish, lease, result})

  def snapshot, do: GenServer.call(__MODULE__, :snapshot)

  @impl true
  def init(opts) do
    delay = Keyword.get(opts, :startup_delay_ms, PollingPolicy.startup_delay_ms())

    {:ok,
     %{
       fingerprint: nil,
       status: :startup,
       failures: 0,
       due: now() + delay,
       lease: nil,
       monitor: nil
     }}
  end

  @impl true
  def handle_call({:checkout, fingerprint}, {pid, _}, state) do
    state =
      if state.fingerprint != nil and state.fingerprint != fingerprint and state.lease == nil,
        do: %{state | status: :ok, failures: 0, due: now()},
        else: state

    state = if state.lease == nil, do: %{state | fingerprint: fingerprint}, else: state

    cond do
      state.lease != nil ->
        {:reply, {:error, {:poll_deferred, :busy, 1000}}, state}

      state.status == :permanent ->
        {:reply, {:error, {:poll_deferred, :permanent, nil}}, state}

      state.due > now() ->
        {:reply, {:error, {:poll_deferred, state.status, state.due - now()}}, state}

      true ->
        lease = make_ref()
        {:reply, {:ok, lease}, %{state | lease: lease, monitor: Process.monitor(pid)}}
    end
  end

  def handle_call({:finish, lease, result}, _from, %{lease: lease} = state)
      when is_reference(lease) do
    Process.demonitor(state.monitor, [:flush])
    {:reply, :ok, record_result(%{state | lease: nil, monitor: nil}, result)}
  end

  def handle_call({:finish, _, _}, _from, state), do: {:reply, :ok, state}

  def handle_call(:snapshot, _from, state) do
    {:reply,
     %{
       outcome: state.status,
       failures: state.failures,
       next_retry_in_ms: if(state.status == :permanent, do: nil, else: max(0, state.due - now()))
     }, state}
  end

  @impl true
  def handle_info({:DOWN, monitor, :process, _, _}, %{monitor: monitor} = state) do
    {:noreply, record_result(%{state | lease: nil, monitor: nil}, {:error, :request_interrupted})}
  end

  def handle_info(_, state), do: {:noreply, state}

  defp record_result(state, result) do
    status = PollingPolicy.classify(result)
    failures = if status == :ok, do: 0, else: min(state.failures + 1, 32)
    delay = if status == :transient, do: PollingPolicy.failure_delay_ms(failures), else: 0

    next_retry =
      if status == :permanent, do: "config_change_or_restart", else: Integer.to_string(delay)

    Logger.info(
      "symphony_linear outcome=#{status} failures=#{failures} next_retry_ms=#{next_retry}"
    )

    %{state | status: status, failures: failures, due: now() + delay}
  end

  defp now, do: System.monotonic_time(:millisecond)
end
