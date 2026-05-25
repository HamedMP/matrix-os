defmodule Mix.Tasks.PrBody.Check do
  use Mix.Task

  @shortdoc "Validate PR body format against the repository PR template"

  @moduledoc """
  Validates a PR description markdown file against the structure and expectations
  implied by the repository pull request template.

  Usage:

      mix pr_body.check --file /path/to/pr_body.md
  """

  @template_paths [
    ".github/pull_request_template.md",
    "../.github/pull_request_template.md"
  ]

  @impl Mix.Task
  def run(args) do
    {opts, _argv, invalid} = OptionParser.parse(args, strict: [file: :string, help: :boolean], aliases: [h: :help])

    cond do
      opts[:help] ->
        Mix.shell().info(@moduledoc)

      invalid != [] ->
        Mix.raise("Invalid option(s): #{inspect(invalid)}")

      true ->
        file_path = required_opt(opts, :file)

        with {:ok, template_path, template} <- read_template(),
             {:ok, body} <- read_file(file_path),
             {:ok, headings} <- extract_template_headings(template, template_path),
             :ok <- lint_and_print(template_path, template, body, headings) do
          Mix.shell().info("PR body format OK")
        else
          {:error, message} -> Mix.raise(message)
        end
    end
  end

  defp read_template do
    case Enum.find_value(@template_paths, &read_template_candidate/1) do
      {:ok, _path, _template} = result ->
        result

      nil ->
        joined_paths = Enum.join(@template_paths, ", ")
        {:error, "Unable to read PR template from any of: #{joined_paths}"}
    end
  end

  defp read_template_candidate(path) do
    case File.read(path) do
      {:ok, content} -> {:ok, path, content}
      {:error, _reason} -> nil
    end
  end

  defp required_opt(opts, key) do
    case opts[key] do
      nil -> Mix.raise("Missing required option --#{key}")
      value -> value
    end
  end

  defp read_file(path) do
    case File.read(path) do
      {:ok, content} -> {:ok, content}
      {:error, reason} -> {:error, "Unable to read #{path}: #{inspect(reason)}"}
    end
  end

  defp extract_template_headings(template, template_path) do
    headings =
      Regex.scan(~r/^\#{2,6}\s+.+$/m, template)
      |> Enum.map(&hd/1)

    if headings == [] do
      {:error, "No markdown headings found in #{template_path}"}
    else
      {:ok, headings}
    end
  end

  defp lint_and_print(template_path, template, body, headings) do
    errors = lint(template, body, headings)

    if errors == [] do
      :ok
    else
      Enum.each(errors, fn err -> Mix.shell().error("ERROR: #{err}") end)

      {:error, "PR body format invalid. Read `#{template_path}` and follow it precisely."}
    end
  end

  defp lint(template, body, headings) do
    []
    |> check_required_headings(body, headings)
    |> check_order(body, headings)
    |> check_no_placeholders(body)
    |> check_sections_from_template(template, body, headings)
  end

  defp check_required_headings(errors, body, headings) do
    missing = Enum.filter(headings, fn heading -> heading_position(body, heading) == :nomatch end)
    errors ++ Enum.map(missing, fn heading -> "Missing required heading: #{heading}" end)
  end

  defp check_order(errors, body, headings) do
    positions =
      headings
      |> Enum.map(&heading_position(body, &1))
      |> Enum.reject(&(&1 == :nomatch))

    if positions == Enum.sort(positions), do: errors, else: errors ++ ["Required headings are out of order."]
  end

  defp check_no_placeholders(errors, body) do
    if String.contains?(body, "<!--") do
      errors ++ ["PR description still contains template placeholder comments (<!-- ... -->)."]
    else
      errors
    end
  end

  defp check_sections_from_template(errors, template, body, headings) do
    Enum.reduce(headings, errors, fn heading, acc ->
      template_section = capture_heading_section(template, heading, headings)
      body_section = capture_heading_section(body, heading, headings)

      cond do
        is_nil(body_section) ->
          acc

        String.trim(body_section) == "" ->
          acc ++ ["Section cannot be empty: #{heading}"]

        true ->
          acc
          |> maybe_require_bullets(heading, template_section, body_section)
          |> maybe_require_checkboxes(heading, template_section, body_section)
      end
    end)
  end

  defp maybe_require_bullets(errors, heading, template_section, body_section) do
    requires_bullets = Regex.match?(~r/^- /m, template_section || "")

    if requires_bullets and not Regex.match?(~r/^- /m, body_section) do
      errors ++ ["Section must include at least one bullet item: #{heading}"]
    else
      errors
    end
  end

  defp maybe_require_checkboxes(errors, heading, template_section, body_section) do
    requires_checkboxes = Regex.match?(~r/^- \[ \] /m, template_section || "")

    if requires_checkboxes and not Regex.match?(~r/^- \[[ xX]\] /m, body_section) do
      errors ++ ["Section must include at least one checkbox item: #{heading}"]
    else
      errors
    end
  end

  defp heading_position(body, heading) do
    case :binary.match(body, heading) do
      {idx, _len} -> idx
      :nomatch -> :nomatch
    end
  end

  defp capture_heading_section(doc, heading, headings) do
    with {heading_idx, _} <- :binary.match(doc, heading),
         section_start <- heading_idx + byte_size(heading),
         content_start when content_start > section_start <- skip_heading_newlines(doc, section_start) do
      extract_section_content(doc, content_start, heading, headings)
    else
      :nomatch -> nil
      _ -> nil
    end
  end

  defp skip_heading_newlines(doc, index) when index < byte_size(doc) do
    case :binary.at(doc, index) do
      char when char in [?\n, ?\r] -> skip_heading_newlines(doc, index + 1)
      _ -> index
    end
  end

  defp skip_heading_newlines(_doc, index), do: index

  defp extract_section_content(doc, content_start, heading, headings) do
    content = binary_part(doc, content_start, byte_size(doc) - content_start)

    case next_heading_offset(content, heading, headings) do
      nil -> content
      offset -> binary_part(content, 0, offset)
    end
  end

  defp next_heading_offset(content, heading, headings) do
    headings_after(heading, headings)
    |> Enum.map(fn marker -> :binary.match(content, marker) end)
    |> Enum.filter(&(&1 != :nomatch))
    |> Enum.map(fn {idx, _} -> idx end)
    |> case do
      [] -> nil
      indexes -> Enum.min(indexes)
    end
  end

  defp headings_after(current_heading, headings) do
    headings
    |> Enum.drop_while(&(&1 != current_heading))
    |> Enum.drop(1)
    |> Enum.map(&("\n" <> &1))
  end
end
