defmodule SymphonyElixir.TerminalCapabilities do
  @moduledoc false

  def output_available? do
    case :io.columns() do
      {:ok, columns} when is_integer(columns) and columns > 0 -> true
      _ -> false
    end
  end
end
