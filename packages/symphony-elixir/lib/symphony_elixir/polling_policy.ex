defmodule SymphonyElixir.PollingPolicy do
  @moduledoc false

  @setup_required_poll_interval_ms 300_000

  def next_delay_ms(:setup_required, poll_interval_ms) do
    max(poll_interval_ms, @setup_required_poll_interval_ms)
  end

  def next_delay_ms(_tracker_status, poll_interval_ms), do: poll_interval_ms
end
