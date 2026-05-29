defmodule Mix.Tasks.Specs.Check do
  use Mix.Task

  alias SymphonyElixir.SpecsCheck

  @moduledoc """
  Enforces adjacent `@spec` declarations for public APIs in `lib/`.
  """
  @shortdoc "Fails when public functions in lib/ are missing adjacent @specs"

  @switches [paths: :keep, exemptions_file: :string]
  @default_paths ["lib"]

  @impl Mix.Task
  def run(args) do
    {opts, _argv, _invalid} = OptionParser.parse(args, strict: @switches)

    paths = Keyword.get_values(opts, :paths)
    scanned_paths = if paths == [], do: @default_paths, else: paths

    exemptions =
      case Keyword.get(opts, :exemptions_file) do
        nil -> MapSet.new()
        path -> load_exemptions(path)
      end

    findings = SpecsCheck.missing_public_specs(scanned_paths, exemptions: exemptions)

    if findings == [] do
      Mix.shell().info("specs.check: all public functions have @spec or exemption")
      :ok
    else
      Enum.each(findings, fn finding ->
        Mix.shell().error("#{finding.file}:#{finding.line} missing @spec for #{SpecsCheck.finding_identifier(finding)}")
      end)

      Mix.raise("specs.check failed with #{length(findings)} missing @spec declaration(s)")
    end
  end

  defp load_exemptions(path) do
    if File.exists?(path) do
      path
      |> File.read!()
      |> String.split("\n")
      |> Enum.map(&String.trim/1)
      |> Enum.reject(&(&1 == "" or String.starts_with?(&1, "#")))
      |> MapSet.new()
    else
      MapSet.new()
    end
  end
end
