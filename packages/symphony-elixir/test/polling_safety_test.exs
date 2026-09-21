ExUnit.start()

unless Code.ensure_loaded?(SymphonyElixir.PollingPolicy),
  do: Code.require_file("../lib/symphony_elixir/polling_policy.ex", __DIR__)

unless Code.ensure_loaded?(SymphonyElixir.Linear.RequestGate),
  do: Code.require_file("../lib/symphony_elixir/linear/request_gate.ex", __DIR__)

defmodule PollingSafetyTest do
  use ExUnit.Case
  alias SymphonyElixir.{PollingPolicy, Linear.RequestGate}

  test "permanent errors latch closed, including wrapped HTTP and configuration errors" do
    for reason <- [
          {:linear_api_status, 400},
          {:linear_api_status, 401},
          {:linear_api_status, 403},
          {:linear_api_status, 404},
          {:linear_api_status, 422},
          :missing_linear_project_slug,
          {:linear_api_request, :missing_upgrade_token},
          :unsupported_bridge_operation
        ] do
      assert PollingPolicy.classify({:error, reason}) == :permanent
    end

    for status <- [408, 429, 500, 502, 503, 504] do
      assert PollingPolicy.classify({:error, {:linear_api_status, status}}) == :transient
    end
  end

  test "transient backoff grows, has jitter, and stays bounded even after a million failures" do
    assert PollingPolicy.failure_delay_ms(1, 0.0) == 30_000
    assert PollingPolicy.failure_delay_ms(2, 0.0) == 60_000
    assert PollingPolicy.failure_delay_ms(3, 0.0) == 120_000
    assert PollingPolicy.failure_delay_ms(1, 0.9) > 30_000
    assert PollingPolicy.failure_delay_ms(1_000_000, 1.0) == 900_000
    assert PollingPolicy.next_delay_ms(:ok, 5000, 0.0) >= 30_000

    assert PollingPolicy.next_delay_ms(:ok, 5000, 0.9) >
             PollingPolicy.next_delay_ms(:ok, 5000, 0.0)
  end

  test "100 simultaneous runtimes spread startup and bound persistent failure requests" do
    # Deterministic strata make this a reproducible fleet rate test, not a flaky random test.
    starts = for n <- 0..99, do: PollingPolicy.startup_delay_ms(n / 100)
    assert Enum.min(starts) >= 1000
    assert map_size(Enum.frequencies_by(starts, &div(&1, 1000))) >= 50

    requests =
      for {start, n} <- Enum.with_index(starts) do
        Enum.reduce_while(1..1000, {start, 0}, fn attempt, {time, count} ->
          if time >= 3_600_000,
            do: {:halt, count},
            else: {:cont, {time + PollingPolicy.failure_delay_ms(attempt, n / 100), count + 1}}
        end)
      end

    assert Enum.sum(requests) <= 1500
  end

  test "one permanent response suppresses a thousand retries until configuration changes" do
    {:ok, gate} = RequestGate.start_link(name: nil, startup_delay_ms: 0)
    assert {:ok, lease} = RequestGate.checkout(gate, :config_a)
    :ok = RequestGate.finish(gate, lease, {:error, {:linear_api_status, 400}})

    for _ <- 1..1000 do
      assert {:error, {:poll_deferred, :permanent, nil}} = RequestGate.checkout(gate, :config_a)
    end

    assert {:ok, _lease} = RequestGate.checkout(gate, :config_b)
    GenServer.stop(gate)
  end

  test "transient failures and concurrent callers cannot bypass the shared gate" do
    {:ok, gate} = RequestGate.start_link(name: nil, startup_delay_ms: 0)
    assert {:ok, lease} = RequestGate.checkout(gate, :config)
    assert {:error, {:poll_deferred, :busy, _}} = RequestGate.checkout(gate, :config)
    :ok = RequestGate.finish(gate, lease, {:error, {:linear_api_status, 503}})

    for _ <- 1..1000 do
      assert {:error, {:poll_deferred, :transient, delay}} = RequestGate.checkout(gate, :config)
      assert delay > 0 and delay <= 900_000
    end

    GenServer.stop(gate)
  end

  test "backoff grows across real gate failures and a successful request resets it" do
    {:ok, gate} = RequestGate.start_link(name: nil, startup_delay_ms: 0)

    for attempt <- 1..4 do
      :sys.replace_state(gate, &%{&1 | due: System.monotonic_time(:millisecond) - 1})
      assert {:ok, lease} = RequestGate.checkout(gate, :config)
      :ok = RequestGate.finish(gate, lease, {:error, {:linear_api_status, 503}})
      state = :sys.get_state(gate)
      assert state.failures == attempt
      remaining = state.due - System.monotonic_time(:millisecond)
      assert remaining >= PollingPolicy.failure_delay_ms(attempt, 0.0) - 100
      assert remaining <= PollingPolicy.failure_delay_ms(attempt, 1.0)
    end

    :sys.replace_state(gate, &%{&1 | due: System.monotonic_time(:millisecond) - 1})
    assert {:ok, lease} = RequestGate.checkout(gate, :config)
    :ok = RequestGate.finish(gate, lease, {:ok, %{}})
    assert :sys.get_state(gate).failures == 0
    assert {:ok, _} = RequestGate.checkout(gate, :config)
    GenServer.stop(gate)
  end

  test "successful earlier pages cannot reset backoff for a persistently failing page" do
    {:ok, gate} = RequestGate.start_link(name: nil, startup_delay_ms: 0)

    for attempt <- 1..4 do
      :sys.replace_state(gate, &%{&1 | due: System.monotonic_time(:millisecond) - 1})
      assert {:ok, viewer} = RequestGate.checkout_request(gate, :config, :viewer)
      :ok = RequestGate.finish(gate, viewer, {:ok, %{}})
      assert {:ok, page} = RequestGate.checkout_request(gate, :config, :failing_page)
      :ok = RequestGate.finish(gate, page, {:error, {:linear_api_status, 503}})
      assert :sys.get_state(gate).failures == attempt
    end

    GenServer.stop(gate)
  end

  test "operation suppression has a bounded cache and expires without blocking other requests" do
    {:ok, gate} = RequestGate.start_link(name: nil, startup_delay_ms: 0)

    for key <- 1..129 do
      assert {:ok, lease} = RequestGate.checkout_request(gate, :config, key)
      :ok = RequestGate.finish(gate, lease, {:error, :linear_operation_error})
    end

    assert map_size(:sys.get_state(gate).operation_errors) == 128
    assert {:error, :linear_operation_error} = RequestGate.checkout_request(gate, :config, 129)

    :sys.replace_state(gate, fn state ->
      %{
        state
        | operation_errors:
            Map.new(state.operation_errors, fn {key, _} ->
              {key, System.monotonic_time(:millisecond) - 1}
            end)
      }
    end)

    assert {:ok, lease} = RequestGate.checkout_request(gate, :config, 129)
    :ok = RequestGate.finish(gate, lease, {:ok, %{}})
    assert :sys.get_state(gate).operation_errors == %{}
    GenServer.stop(gate)
  end
end
