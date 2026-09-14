defmodule SymphonyElixir.PollingPolicy do
  @moduledoc "Bounded fleet scheduling. Permanent failures need a config change or explicit restart."

  def startup_delay_ms(random \\ :rand.uniform()), do: 1_000 + round(random * 59_000)

  def next_delay_ms(status, interval, random \\ :rand.uniform()) do
    base = if status == :setup_required, do: max(interval, 300_000), else: max(interval, 30_000)
    base + round(base * 0.5 * random)
  end

  def failure_delay_ms(attempt, random \\ :rand.uniform()) do
    base = min(600_000, 30_000 * Integer.pow(2, min(max(attempt - 1, 0), 5)))
    base + round(base * 0.5 * random)
  end

  def classify({:ok, _}), do: :ok
  def classify({:error, :linear_operation_error}), do: :operation_error
  def classify({:error, {:linear_api_status, status}}) when status in [408, 429], do: :transient

  def classify({:error, {:linear_api_status, status}}) when status >= 400 and status < 500,
    do: :permanent

  def classify({:error, {:linear_api_status, status}}) when status >= 500, do: :transient
  def classify({:error, {:linear_api_request, reason}}), do: classify({:error, reason})
  def classify({:error, {:poll_deferred, status, _}}), do: status

  def classify({:error, reason}) when reason in [:network_error, :request_interrupted],
    do: :transient

  # Config, unsupported contract, GraphQL validation, and malformed success payloads
  # must not be retried automatically. Transport errors are normalized above.
  def classify({:error, _}), do: :permanent
end
