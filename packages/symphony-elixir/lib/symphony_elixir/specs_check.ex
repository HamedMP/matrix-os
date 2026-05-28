defmodule SymphonyElixir.SpecsCheck do
  @moduledoc false

  @type finding :: %{
          file: String.t(),
          module: String.t(),
          name: atom(),
          arity: non_neg_integer(),
          line: pos_integer()
        }

  @spec missing_public_specs([Path.t()], keyword()) :: [finding()]
  def missing_public_specs(paths, opts \\ []) do
    exemptions =
      opts
      |> Keyword.get(:exemptions, [])
      |> MapSet.new()

    paths
    |> Enum.flat_map(&collect_elixir_files/1)
    |> Enum.flat_map(&file_findings(&1, exemptions))
    |> Enum.sort_by(&{&1.file, &1.line, &1.name, &1.arity})
  end

  @spec finding_identifier(finding()) :: String.t()
  def finding_identifier(%{module: module, name: name, arity: arity}) do
    "#{module}.#{name}/#{arity}"
  end

  defp collect_elixir_files(path) do
    cond do
      File.regular?(path) and String.ends_with?(path, ".ex") ->
        [path]

      File.dir?(path) ->
        Path.wildcard(Path.join(path, "**/*.ex"))

      true ->
        []
    end
  end

  defp file_findings(file, exemptions) do
    with {:ok, source} <- File.read(file),
         {:ok, ast} <- Code.string_to_quoted(source, columns: true, file: file) do
      ast
      |> module_nodes()
      |> Enum.flat_map(fn {module_name, body} ->
        find_missing_specs(body, module_name, file, exemptions)
      end)
    else
      {:error, {line, error, token}} ->
        Mix.raise("Unable to parse #{file}:#{line} #{error} #{inspect(token)}")

      {:error, reason} ->
        Mix.raise("Unable to read #{file}: #{inspect(reason)}")
    end
  end

  defp module_nodes(ast) do
    {_ast, modules} =
      Macro.prewalk(ast, [], fn
        {:defmodule, _meta, [module_ast, [do: body]]} = node, acc ->
          {node, [{Macro.to_string(module_ast), body} | acc]}

        node, acc ->
          {node, acc}
      end)

    Enum.reverse(modules)
  end

  defp find_missing_specs(body, module_name, file, exemptions) do
    body
    |> normalize_block()
    |> Enum.reduce(initial_state(), fn form, state ->
      consume_form(form, state, module_name, file, exemptions)
    end)
    |> Map.fetch!(:findings)
  end

  defp initial_state do
    %{pending_specs: MapSet.new(), pending_impl: false, seen_defs: MapSet.new(), findings: []}
  end

  defp consume_form({:@, _, [{:spec, _, spec_nodes}]}, state, _module_name, _file, _exemptions) do
    ids =
      spec_nodes
      |> Enum.flat_map(&extract_spec_identifiers/1)
      |> MapSet.new()

    %{state | pending_specs: MapSet.union(state.pending_specs, ids)}
  end

  defp consume_form({:@, _, [{:impl, _, _}]}, state, _module_name, _file, _exemptions) do
    %{state | pending_impl: true}
  end

  defp consume_form({:@, _, _}, state, _module_name, _file, _exemptions), do: state

  defp consume_form({:def, meta, [head_ast, _]} = _form, state, module_name, file, exemptions) do
    {name, arity} = def_head_to_identifier(head_ast)

    id = {name, arity}

    if MapSet.member?(state.seen_defs, id) do
      %{state | pending_specs: MapSet.new(), pending_impl: false}
    else
      finding = %{
        file: file,
        module: module_name,
        name: name,
        arity: arity,
        line: Keyword.get(meta, :line, 1)
      }

      next_state = %{
        state
        | pending_specs: MapSet.new(),
          pending_impl: false,
          seen_defs: MapSet.put(state.seen_defs, id)
      }

      if compliant?(finding, state, exemptions) do
        next_state
      else
        %{next_state | findings: [finding | next_state.findings]}
      end
    end
  end

  defp consume_form({:defp, _, _}, state, _module_name, _file, _exemptions) do
    %{state | pending_specs: MapSet.new(), pending_impl: false}
  end

  defp consume_form(_form, state, _module_name, _file, _exemptions) do
    %{state | pending_specs: MapSet.new(), pending_impl: false}
  end

  defp compliant?(finding, state, exemptions) do
    id = {finding.name, finding.arity}

    MapSet.member?(state.pending_specs, id) or
      state.pending_impl or
      MapSet.member?(exemptions, finding_identifier(finding))
  end

  defp normalize_block({:__block__, _, forms}), do: forms
  defp normalize_block(form), do: [form]

  defp extract_spec_identifiers({:"::", _, [head, _return_type]}) do
    case spec_head_to_identifier(head) do
      nil -> []
      id -> [id]
    end
  end

  defp extract_spec_identifiers({:when, _, [{:"::", _, [head, _return_type]} | _guards]}) do
    case spec_head_to_identifier(head) do
      nil -> []
      id -> [id]
    end
  end

  defp extract_spec_identifiers(_), do: []

  defp spec_head_to_identifier({:when, _, [inner | _guards]}), do: spec_head_to_identifier(inner)
  defp spec_head_to_identifier({name, _, args}) when is_atom(name) and is_list(args), do: {name, length(args)}
  defp spec_head_to_identifier({name, _, nil}) when is_atom(name), do: {name, 0}
  defp spec_head_to_identifier(_), do: nil

  defp def_head_to_identifier({:when, _, [head | _guards]}), do: def_head_to_identifier(head)
  defp def_head_to_identifier({name, _, args}) when is_atom(name) and is_list(args), do: {name, length(args)}
  defp def_head_to_identifier({name, _, nil}) when is_atom(name), do: {name, 0}
end
