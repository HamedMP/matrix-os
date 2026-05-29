defmodule SymphonyElixir.Linear.Bridge do
  @moduledoc false

  @credential "matrixos:integration:linear"

  @spec credential() :: String.t()
  def credential, do: @credential
end
