defmodule SymphonyElixir.Linear.RequestGate do
  @moduledoc "One shared circuit for polls, reconciliation, cleanup and agent Linear calls."
  use GenServer
  require Logger
  alias SymphonyElixir.PollingPolicy
  @operation_error_ttl_ms 900_000
  @max_operation_errors 128

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  def checkout(server \\ __MODULE__, fingerprint),
    do: checkout_request(server, fingerprint, :default)

  def checkout_request(server \\ __MODULE__, fingerprint, request_key),
    do: GenServer.call(server, {:checkout, fingerprint, request_key})

  def finish(server \\ __MODULE__, lease, result),
    do: GenServer.call(server, {:finish, lease, result})

  def snapshot, do: GenServer.call(__MODULE__, :snapshot)

  @impl true
  def init(opts) do
    delay = Keyword.get(opts, :startup_delay_ms, PollingPolicy.startup_delay_ms())

    {:ok,
     %{
       fingerprint: nil,
       request_key: nil,
       failed_request: nil,
       operation_errors: %{},
       status: :startup,
       failures: 0,
       due: now() + delay,
       lease: nil,
       monitor: nil
     }}
  end

  @impl true
  def handle_call({:checkout, fingerprint, request_key}, {pid, _}, state) do
    state =
      if state.fingerprint != nil and state.fingerprint != fingerprint and state.lease == nil,
        do: %{
          state
          | status: :ok,
            failures: 0,
            failed_request: nil,
            operation_errors: %{},
            due: now()
        },
        else: state

    state = if state.lease == nil, do: %{state | fingerprint: fingerprint}, else: state

    operation_errors =
      Map.reject(state.operation_errors, fn {_key, expires} -> expires <= now() end)

    state = %{state | operation_errors: operation_errors}

    cond do
      Map.has_key?(operation_errors, request_key) ->
        {:reply, {:error, :linear_operation_error}, state}

      state.lease != nil ->
        {:reply, {:error, {:poll_deferred, :busy, 1000}}, state}

      state.status == :permanent ->
        {:reply, {:error, {:poll_deferred, :permanent, nil}}, state}

      state.due > now() ->
        {:reply, {:error, {:poll_deferred, state.status, state.due - now()}}, state}

      true ->
        lease = make_ref()

        {:reply, {:ok, lease},
         %{state | lease: lease, monitor: Process.monitor(pid), request_key: request_key}}
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

  defp record_result(state, {:error, :linear_operation_error}) do
    # Item/input failures are remembered per request, never as a global outage.
    # TTL eviction runs on checkout and the cap bounds dormant process memory.
    errors = state.operation_errors

    errors =
      if map_size(errors) >= @max_operation_errors do
        {oldest, _} = Enum.min_by(errors, fn {_key, expires} -> expires end)
        Map.delete(errors, oldest)
      else
        errors
      end

    errors = Map.put(errors, state.request_key, now() + @operation_error_ttl_ms)

    Logger.info(
      "symphony_linear outcome=operation_error next_retry_ms=#{@operation_error_ttl_ms}"
    )

    %{state | status: :operation_error, operation_errors: errors, request_key: nil}
  end

  defp record_result(state, result) do
    status = PollingPolicy.classify(result)
    # A poll may read a viewer and several pages. Only recovery of the failed
    # request clears its streak; an earlier successful page must not flatten
    # every repeated later-page failure back to the first retry interval.
    recovered = status == :ok and state.failed_request in [nil, state.request_key]

    failures =
      cond do
        recovered -> 0
        status == :ok -> state.failures
        true -> min(state.failures + 1, 32)
      end

    failed_request =
      cond do
        recovered -> nil
        status == :ok -> state.failed_request
        true -> state.request_key
      end

    delay = if status == :transient, do: PollingPolicy.failure_delay_ms(failures), else: 0

    next_retry =
      if status == :permanent, do: "config_change_or_restart", else: Integer.to_string(delay)

    Logger.info(
      "symphony_linear outcome=#{status} failures=#{failures} next_retry_ms=#{next_retry}"
    )

    %{
      state
      | status: status,
        failures: failures,
        failed_request: failed_request,
        request_key: nil,
        due: now() + delay
    }
  end

  defp now, do: System.monotonic_time(:millisecond)
end
