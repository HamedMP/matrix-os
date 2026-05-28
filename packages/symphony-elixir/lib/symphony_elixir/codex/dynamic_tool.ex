defmodule SymphonyElixir.Codex.DynamicTool do
  @moduledoc """
  Executes client-side tool calls requested by Codex app-server turns.
  """

  alias SymphonyElixir.Linear.Client

  @linear_graphql_tool "linear_graphql"
  @linear_graphql_description """
  Execute a raw GraphQL query or mutation against Linear using Symphony's configured auth.
  """
  @linear_graphql_input_schema %{
    "type" => "object",
    "additionalProperties" => false,
    "required" => ["query"],
    "properties" => %{
      "query" => %{
        "type" => "string",
        "description" => "GraphQL query or mutation document to execute against Linear."
      },
      "variables" => %{
        "type" => ["object", "null"],
        "description" => "Optional GraphQL variables object.",
        "additionalProperties" => true
      }
    }
  }

  @sync_workpad_tool "sync_workpad"
  @sync_workpad_description "Create or update a workpad comment on a Linear issue. Reads the body from a local file to keep the conversation context small."
  @sync_workpad_create "mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id url } } }"
  @sync_workpad_update "mutation($id: String!, $body: String!) { commentUpdate(id: $id, input: { body: $body }) { success comment { id url } } }"
  @sync_workpad_input_schema %{
    "type" => "object",
    "additionalProperties" => false,
    "required" => ["issue_id", "file_path"],
    "properties" => %{
      "issue_id" => %{
        "type" => "string",
        "description" => "Linear issue identifier (e.g. \"ENG-123\") or internal UUID."
      },
      "file_path" => %{
        "type" => "string",
        "description" => "Path to a local markdown file whose contents become the comment body."
      },
      "comment_id" => %{
        "type" => "string",
        "description" => "Existing comment ID to update. Omit to create a new comment."
      }
    }
  }

  @spec execute(String.t() | nil, term(), keyword()) :: map()
  def execute(tool, arguments, opts \\ []) do
    case tool do
      @linear_graphql_tool ->
        execute_linear_graphql(arguments, opts)

      @sync_workpad_tool ->
        execute_sync_workpad(arguments, opts)

      other ->
        failure_response(%{
          "error" => %{
            "message" => "Unsupported dynamic tool: #{inspect(other)}.",
            "supportedTools" => supported_tool_names()
          }
        })
    end
  end

  @spec tool_specs() :: [map()]
  def tool_specs do
    [
      %{
        "name" => @linear_graphql_tool,
        "description" => @linear_graphql_description,
        "inputSchema" => @linear_graphql_input_schema
      },
      %{
        "name" => @sync_workpad_tool,
        "description" => @sync_workpad_description,
        "inputSchema" => @sync_workpad_input_schema
      }
    ]
  end

  defp execute_linear_graphql(arguments, opts) do
    linear_client = Keyword.get(opts, :linear_client, &Client.graphql/3)

    with {:ok, query, variables} <- normalize_linear_graphql_arguments(arguments),
         {:ok, response} <- linear_client.(query, variables, []) do
      graphql_response(response)
    else
      {:error, reason} ->
        failure_response(tool_error_payload(reason))
    end
  end

  defp execute_sync_workpad(args, opts) do
    with {:ok, issue_id, file_path, comment_id} <- normalize_sync_workpad_args(args),
         {:ok, body} <- read_workpad_file(file_path, opts) do
      {query, variables} =
        if comment_id,
          do: {@sync_workpad_update, %{"id" => comment_id, "body" => body}},
          else: {@sync_workpad_create, %{"issueId" => issue_id, "body" => body}}

      execute_linear_graphql(%{"query" => query, "variables" => variables}, opts)
    else
      {:error, reason} -> failure_response(tool_error_payload(reason))
    end
  end

  defp normalize_sync_workpad_args(%{} = args) do
    issue_id = Map.get(args, "issue_id") || Map.get(args, :issue_id)
    file_path = Map.get(args, "file_path") || Map.get(args, :file_path)
    comment_id = Map.get(args, "comment_id") || Map.get(args, :comment_id)

    cond do
      not is_binary(issue_id) or issue_id == "" ->
        {:error, {:sync_workpad, "`issue_id` is required"}}

      not is_binary(file_path) or file_path == "" ->
        {:error, {:sync_workpad, "`file_path` is required"}}

      true ->
        comment_id = if is_binary(comment_id) and comment_id != "", do: comment_id
        {:ok, issue_id, file_path, comment_id}
    end
  end

  defp normalize_sync_workpad_args(_args) do
    {:error, {:sync_workpad, "`issue_id` and `file_path` are required"}}
  end

  defp read_workpad_file(path, opts) do
    with {:ok, safe_path} <- resolve_workpad_path(path, Keyword.get(opts, :workspace)) do
      case File.read(safe_path) do
        {:ok, ""} -> {:error, {:sync_workpad, "file is empty"}}
        {:ok, body} -> {:ok, body}
        {:error, reason} -> {:error, {:sync_workpad, "cannot read file: #{:file.format_error(reason)}"}}
      end
    end
  end

  defp resolve_workpad_path(path, workspace) when is_binary(path) and is_binary(workspace) do
    expanded_root = Path.expand(workspace)
    expanded_path = Path.expand(path, expanded_root)

    with {:ok, real_root} <- File.realpath(expanded_root),
         {:ok, real_path} <- File.realpath(expanded_path),
         true <- path_within?(real_path, real_root) do
      {:ok, real_path}
    else
      false -> {:error, {:sync_workpad, "file path must stay inside the workspace"}}
      {:error, reason} -> {:error, {:sync_workpad, "cannot resolve file: #{:file.format_error(reason)}"}}
    end
  end

  defp resolve_workpad_path(_path, _workspace) do
    {:error, {:sync_workpad, "workspace boundary is required"}}
  end

  defp path_within?(path, root) do
    relative = Path.relative_to(path, root)

    cond do
      relative == path -> false
      relative == "." -> false
      relative == ".." or String.starts_with?(relative, "../") -> false
      true -> true
    end
  end

  defp normalize_linear_graphql_arguments(arguments) when is_binary(arguments) do
    case String.trim(arguments) do
      "" -> {:error, :missing_query}
      query -> {:ok, query, %{}}
    end
  end

  defp normalize_linear_graphql_arguments(arguments) when is_map(arguments) do
    case normalize_query(arguments) do
      {:ok, query} ->
        case normalize_variables(arguments) do
          {:ok, variables} ->
            {:ok, query, variables}

          {:error, reason} ->
            {:error, reason}
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp normalize_linear_graphql_arguments(_arguments), do: {:error, :invalid_arguments}

  defp normalize_query(arguments) do
    case Map.get(arguments, "query") || Map.get(arguments, :query) do
      query when is_binary(query) ->
        case String.trim(query) do
          "" -> {:error, :missing_query}
          trimmed -> {:ok, trimmed}
        end

      _ ->
        {:error, :missing_query}
    end
  end

  defp normalize_variables(arguments) do
    case Map.get(arguments, "variables") || Map.get(arguments, :variables) || %{} do
      variables when is_map(variables) -> {:ok, variables}
      _ -> {:error, :invalid_variables}
    end
  end

  defp graphql_response(response) do
    success =
      case response do
        %{"errors" => errors} when is_list(errors) and errors != [] -> false
        %{errors: errors} when is_list(errors) and errors != [] -> false
        _ -> true
      end

    %{
      "success" => success,
      "contentItems" => [
        %{
          "type" => "inputText",
          "text" => encode_payload(response)
        }
      ]
    }
  end

  defp failure_response(payload) do
    %{
      "success" => false,
      "contentItems" => [
        %{
          "type" => "inputText",
          "text" => encode_payload(payload)
        }
      ]
    }
  end

  defp encode_payload(payload) when is_map(payload) or is_list(payload) do
    Jason.encode!(payload, pretty: true)
  end

  defp encode_payload(payload), do: inspect(payload)

  defp tool_error_payload({:sync_workpad, message}) do
    %{"error" => %{"message" => "sync_workpad: #{message}"}}
  end

  defp tool_error_payload(:missing_query) do
    %{
      "error" => %{
        "message" => "`linear_graphql` requires a non-empty `query` string."
      }
    }
  end

  defp tool_error_payload(:invalid_arguments) do
    %{
      "error" => %{
        "message" => "`linear_graphql` expects either a GraphQL query string or an object with `query` and optional `variables`."
      }
    }
  end

  defp tool_error_payload(:invalid_variables) do
    %{
      "error" => %{
        "message" => "`linear_graphql.variables` must be a JSON object when provided."
      }
    }
  end

  defp tool_error_payload(:missing_linear_api_token) do
    %{
      "error" => %{
        "message" => "Symphony is missing Linear auth. Connect Linear in Matrix or configure the Symphony credential bridge."
      }
    }
  end

  defp tool_error_payload({:linear_api_status, status}) do
    %{
      "error" => %{
        "message" => "Linear GraphQL request failed with HTTP #{status}.",
        "status" => status
      }
    }
  end

  defp tool_error_payload({:linear_api_request, reason}) do
    %{
      "error" => %{
        "message" => "Linear GraphQL request failed before receiving a successful response.",
        "reason" => inspect(reason)
      }
    }
  end

  defp tool_error_payload(reason) do
    %{
      "error" => %{
        "message" => "Linear GraphQL tool execution failed.",
        "reason" => inspect(reason)
      }
    }
  end

  defp supported_tool_names do
    Enum.map(tool_specs(), & &1["name"])
  end
end
