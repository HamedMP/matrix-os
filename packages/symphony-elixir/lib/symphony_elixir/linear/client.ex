defmodule SymphonyElixir.Linear.Client do
  @moduledoc """
  Thin Linear GraphQL client for polling candidate issues.
  """

  require Logger
  alias SymphonyElixir.{Config, Linear.Bridge, Linear.Issue, Linear.RequestGate}

  @issue_page_size 50
  @max_pages 200

  @query """
  query SymphonyLinearPoll($projectSlug: String!, $stateNames: [String!]!, $first: Int!, $relationFirst: Int!, $after: String) {
    issues(filter: {project: {slugId: {eq: $projectSlug}}, state: {name: {in: $stateNames}}}, first: $first, after: $after) {
      nodes {
        id
        identifier
        title
        description
        priority
        state {
          name
        }
        branchName
        url
        assignee {
          id
        }
        labels {
          nodes {
            name
          }
        }
        inverseRelations(first: $relationFirst) {
          nodes {
            type
            issue {
              id
              identifier
              state {
                name
              }
            }
          }
        }
        createdAt
        updatedAt
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
  """

  @query_by_ids """
  query SymphonyLinearIssuesById($ids: [ID!]!, $first: Int!, $relationFirst: Int!) {
    issues(filter: {id: {in: $ids}}, first: $first) {
      nodes {
        id
        identifier
        title
        description
        priority
        state {
          name
        }
        branchName
        url
        assignee {
          id
        }
        labels {
          nodes {
            name
          }
        }
        inverseRelations(first: $relationFirst) {
          nodes {
            type
            issue {
              id
              identifier
              state {
                name
              }
            }
          }
        }
        createdAt
        updatedAt
      }
    }
  }
  """

  @viewer_query """
  query SymphonyLinearViewer {
    viewer {
      id
    }
  }
  """

  @spec fetch_candidate_issues() :: {:ok, [Issue.t()]} | {:error, term()}
  def fetch_candidate_issues do
    tracker = Config.settings!().tracker
    project_slug = tracker.project_slug

    cond do
      is_nil(tracker.api_key) ->
        {:error, :missing_linear_api_token}

      is_nil(project_slug) ->
        {:error, :missing_linear_project_slug}

      true ->
        with {:ok, assignee_filter} <- routing_assignee_filter() do
          do_fetch_by_states(project_slug, tracker.active_states, assignee_filter)
        end
    end
  end

  @spec fetch_issues_by_states([String.t()]) :: {:ok, [Issue.t()]} | {:error, term()}
  def fetch_issues_by_states(state_names) when is_list(state_names) do
    normalized_states = Enum.map(state_names, &to_string/1) |> Enum.uniq()

    if normalized_states == [] do
      {:ok, []}
    else
      tracker = Config.settings!().tracker
      project_slug = tracker.project_slug

      cond do
        is_nil(tracker.api_key) ->
          {:error, :missing_linear_api_token}

        is_nil(project_slug) ->
          {:error, :missing_linear_project_slug}

        true ->
          do_fetch_by_states(project_slug, normalized_states, nil)
      end
    end
  end

  @spec fetch_issue_states_by_ids([String.t()]) :: {:ok, [Issue.t()]} | {:error, term()}
  def fetch_issue_states_by_ids(issue_ids) when is_list(issue_ids) do
    ids = Enum.uniq(issue_ids)

    case ids do
      [] ->
        {:ok, []}

      ids ->
        with {:ok, assignee_filter} <- routing_assignee_filter() do
          do_fetch_issue_states(ids, assignee_filter)
        end
    end
  end

  @spec graphql(String.t(), map(), keyword()) :: {:ok, map()} | {:error, term()}
  def graphql(query, variables \\ %{}, opts \\ [])
      when is_binary(query) and is_map(variables) and is_list(opts) do
    payload = build_graphql_payload(query, variables, Keyword.get(opts, :operation_name))
    request_fun = Keyword.get(opts, :request_fun) || graphql_request_fun()

    tracker = Config.settings!().tracker

    fingerprint =
      :crypto.hash(
        :sha256,
        :erlang.term_to_binary(
          {tracker, System.get_env("PLATFORM_INTERNAL_URL"), System.get_env("MATRIX_HANDLE"),
           System.get_env("UPGRADE_TOKEN")}
        )
      )

    with :ok <- configured_tracker(tracker),
         :ok <- supported_request(tracker, payload),
         {:ok, lease} <-
           RequestGate.checkout_request(
             fingerprint,
             :crypto.hash(:sha256, :erlang.term_to_binary(payload))
           ) do
      result = perform_request(payload, request_fun)
      :ok = RequestGate.finish(lease, result)
      result
    end
  end

  defp supported_request(tracker, payload) do
    if tracker.api_key == Bridge.credential() do
      case bridge_action(payload["query"]) do
        {:ok, _} -> :ok
        error -> error
      end
    else
      :ok
    end
  end

  defp configured_tracker(%{api_key: nil}), do: {:error, :missing_linear_api_token}
  defp configured_tracker(%{project_slug: nil}), do: {:error, :missing_linear_project_slug}
  defp configured_tracker(_), do: :ok

  defp perform_request(payload, request_fun) do
    with {:ok, headers} <- graphql_headers(),
         {:ok, response} <- request_fun.(payload, headers) do
      decode_response(response)
    else
      {:error, reason} when is_atom(reason) -> {:error, reason}
      {:error, _reason} -> {:error, :network_error}
    end
  rescue
    _error ->
      Logger.warning("symphony_linear outcome=request_failed")
      {:error, :network_error}
  end

  # Linear documents HTTP 400 + RATELIMITED as retryable. Classify structured
  # codes only; never inspect or log provider messages.
  defp decode_response(%{status: status, body: %{"errors" => errors}})
       when status in [200, 400] and is_list(errors) and errors != [] do
    codes =
      errors
      |> Enum.take(100)
      |> Enum.map(fn
        %{"extensions" => %{"code" => code}} when is_binary(code) -> code
        _ -> nil
      end)

    cond do
      Enum.any?(
        codes,
        &(&1 in [
            "UNAUTHENTICATED",
            "AUTHENTICATION_ERROR",
            "GRAPHQL_VALIDATION_FAILED",
            "GRAPHQL_PARSE_FAILED",
            "CONFIGURATION_ERROR"
          ])
      ) ->
        {:error, :linear_contract_error}

      "RATELIMITED" in codes ->
        {:error, {:linear_api_status, 429}}

      Enum.any?(codes, &(&1 in ["INTERNAL_SERVER_ERROR", "INTERNAL_ERROR"])) ->
        {:error, :network_error}

      true ->
        {:error, :linear_operation_error}
    end
  end

  defp decode_response(%{status: 200, body: %{"data" => data} = body}) when is_map(data),
    do: {:ok, body}

  defp decode_response(%{status: 200}), do: {:error, :linear_unknown_payload}
  defp decode_response(%{status: status}), do: {:error, {:linear_api_status, status}}

  @doc false
  @spec normalize_issue_for_test(map()) :: Issue.t() | nil
  def normalize_issue_for_test(issue) when is_map(issue) do
    normalize_issue(issue, nil)
  end

  @doc false
  @spec normalize_issue_for_test(map(), String.t() | nil) :: Issue.t() | nil
  def normalize_issue_for_test(issue, assignee) when is_map(issue) do
    assignee_filter =
      case assignee do
        value when is_binary(value) ->
          case build_assignee_filter(value) do
            {:ok, filter} -> filter
            {:error, _reason} -> nil
          end

        _ ->
          nil
      end

    normalize_issue(issue, assignee_filter)
  end

  @doc false
  @spec next_page_cursor_for_test(map()) :: {:ok, String.t()} | :done | {:error, term()}
  def next_page_cursor_for_test(page_info) when is_map(page_info), do: next_page_cursor(page_info)

  @doc false
  @spec merge_issue_pages_for_test([[Issue.t()]]) :: [Issue.t()]
  def merge_issue_pages_for_test(issue_pages) when is_list(issue_pages) do
    issue_pages
    |> Enum.reduce([], &prepend_page_issues/2)
    |> finalize_paginated_issues()
  end

  @doc false
  @spec fetch_issue_states_by_ids_for_test([String.t()], (String.t(), map() ->
                                                            {:ok, map()} | {:error, term()})) ::
          {:ok, [Issue.t()]} | {:error, term()}
  def fetch_issue_states_by_ids_for_test(issue_ids, graphql_fun)
      when is_list(issue_ids) and is_function(graphql_fun, 2) do
    ids = Enum.uniq(issue_ids)

    case ids do
      [] ->
        {:ok, []}

      ids ->
        do_fetch_issue_states(ids, nil, graphql_fun)
    end
  end

  defp do_fetch_by_states(project_slug, state_names, assignee_filter) do
    do_fetch_by_states_page(project_slug, state_names, assignee_filter, nil, [], @max_pages)
  end

  defp do_fetch_by_states_page(
         _project_slug,
         _state_names,
         _assignee_filter,
         _after_cursor,
         acc_issues,
         0
       ) do
    Logger.warning(
      "Linear pagination hit the #{@max_pages}-page limit; returning partial results"
    )

    {:ok, finalize_paginated_issues(acc_issues)}
  end

  defp do_fetch_by_states_page(
         project_slug,
         state_names,
         assignee_filter,
         after_cursor,
         acc_issues,
         pages_remaining
       ) do
    with {:ok, body} <-
           graphql(@query, %{
             projectSlug: project_slug,
             stateNames: state_names,
             first: @issue_page_size,
             relationFirst: @issue_page_size,
             after: after_cursor
           }),
         {:ok, issues, page_info} <- decode_linear_page_response(body, assignee_filter) do
      updated_acc = prepend_page_issues(issues, acc_issues)

      case next_page_cursor(page_info) do
        {:ok, next_cursor} ->
          do_fetch_by_states_page(
            project_slug,
            state_names,
            assignee_filter,
            next_cursor,
            updated_acc,
            pages_remaining - 1
          )

        :done ->
          {:ok, finalize_paginated_issues(updated_acc)}

        {:error, reason} ->
          {:error, reason}
      end
    end
  end

  defp prepend_page_issues(issues, acc_issues) when is_list(issues) and is_list(acc_issues) do
    Enum.reverse(issues, acc_issues)
  end

  defp finalize_paginated_issues(acc_issues) when is_list(acc_issues),
    do: Enum.reverse(acc_issues)

  defp do_fetch_issue_states(ids, assignee_filter) do
    do_fetch_issue_states(ids, assignee_filter, &graphql/2)
  end

  defp do_fetch_issue_states(ids, assignee_filter, graphql_fun)
       when is_list(ids) and is_function(graphql_fun, 2) do
    issue_order_index = issue_order_index(ids)
    do_fetch_issue_states_page(ids, assignee_filter, graphql_fun, [], issue_order_index)
  end

  defp do_fetch_issue_states_page(
         [],
         _assignee_filter,
         _graphql_fun,
         acc_issues,
         issue_order_index
       ) do
    acc_issues
    |> finalize_paginated_issues()
    |> sort_issues_by_requested_ids(issue_order_index)
    |> then(&{:ok, &1})
  end

  defp do_fetch_issue_states_page(
         ids,
         assignee_filter,
         graphql_fun,
         acc_issues,
         issue_order_index
       ) do
    {batch_ids, rest_ids} = Enum.split(ids, @issue_page_size)

    case graphql_fun.(@query_by_ids, %{
           ids: batch_ids,
           first: length(batch_ids),
           relationFirst: @issue_page_size
         }) do
      {:ok, body} ->
        with {:ok, issues} <- decode_linear_response(body, assignee_filter) do
          updated_acc = prepend_page_issues(issues, acc_issues)

          do_fetch_issue_states_page(
            rest_ids,
            assignee_filter,
            graphql_fun,
            updated_acc,
            issue_order_index
          )
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp issue_order_index(ids) when is_list(ids) do
    ids
    |> Enum.with_index()
    |> Map.new()
  end

  defp sort_issues_by_requested_ids(issues, issue_order_index)
       when is_list(issues) and is_map(issue_order_index) do
    fallback_index = map_size(issue_order_index)

    Enum.sort_by(issues, fn
      %Issue{id: issue_id} -> Map.get(issue_order_index, issue_id, fallback_index)
      _ -> fallback_index
    end)
  end

  defp build_graphql_payload(query, variables, operation_name) do
    %{
      "query" => query,
      "variables" => variables
    }
    |> maybe_put_operation_name(operation_name)
  end

  defp maybe_put_operation_name(payload, operation_name) when is_binary(operation_name) do
    trimmed = String.trim(operation_name)

    if trimmed == "" do
      payload
    else
      Map.put(payload, "operationName", trimmed)
    end
  end

  defp maybe_put_operation_name(payload, _operation_name), do: payload

  defp graphql_headers do
    bridge_credential = Bridge.credential()

    case Config.settings!().tracker.api_key do
      nil ->
        {:error, :missing_linear_api_token}

      ^bridge_credential ->
        {:ok,
         [
           {"Content-Type", "application/json"}
         ]}

      token ->
        {:ok,
         [
           {"Authorization", token},
           {"Content-Type", "application/json"}
         ]}
    end
  end

  defp graphql_request_fun do
    bridge_credential = Bridge.credential()

    case Config.settings!().tracker.api_key do
      ^bridge_credential -> &post_matrix_linear_bridge_request/2
      _ -> &post_graphql_request/2
    end
  end

  defp post_graphql_request(payload, headers) do
    Req.post(Config.settings!().tracker.endpoint,
      headers: headers,
      json: payload,
      retry: false,
      redirect: false,
      connect_options: [timeout: 10_000],
      receive_timeout: 10_000
    )
  end

  defp post_matrix_linear_bridge_request(payload, _headers) do
    with {:ok, action} <- bridge_action(payload["query"]),
         {:ok, url} <- matrix_linear_bridge_url(),
         {:ok, token} <- matrix_linear_bridge_token() do
      Req.post(url,
        headers: [
          {"Authorization", "Bearer " <> token},
          {"Content-Type", "application/json"}
        ],
        json: %{
          service: "linear",
          action: action,
          params: payload["variables"] || %{}
        },
        retry: false,
        redirect: false,
        connect_options: [timeout: 10_000],
        receive_timeout: 10_000
      )
      |> unwrap_matrix_linear_bridge_response()
    end
  end

  defp matrix_linear_bridge_url do
    with {:ok, base_url} <- required_env("PLATFORM_INTERNAL_URL", :missing_platform_internal_url),
         {:ok, handle} <- required_env("MATRIX_HANDLE", :missing_matrix_handle) do
      encoded_handle = URI.encode(handle, &URI.char_unreserved?/1)

      {:ok,
       String.trim_trailing(base_url, "/") <>
         "/internal/containers/" <> encoded_handle <> "/integrations/call"}
    end
  end

  defp matrix_linear_bridge_token do
    required_env("UPGRADE_TOKEN", :missing_upgrade_token)
  end

  defp required_env(name, reason) do
    case System.get_env(name) do
      value when is_binary(value) and value != "" -> {:ok, value}
      _ -> {:error, reason}
    end
  end

  # Only a successful envelope is unwrapped. Preserve every HTTP failure status.
  defp unwrap_matrix_linear_bridge_response(
         {:ok, %{status: 200, body: %{"data" => data}} = response}
       )
       when is_map(data) do
    {:ok, %{response | body: data}}
  end

  defp unwrap_matrix_linear_bridge_response(other), do: other

  defp bridge_action(@query), do: {:ok, "symphony_poll"}
  defp bridge_action(@query_by_ids), do: {:ok, "symphony_issues_by_id"}
  defp bridge_action(@viewer_query), do: {:ok, "symphony_viewer"}
  defp bridge_action(query), do: SymphonyElixir.Linear.Adapter.bridge_action(query)

  defp decode_linear_response(%{"data" => %{"issues" => %{"nodes" => nodes}}}, assignee_filter) do
    issues =
      nodes
      |> Enum.map(&normalize_issue(&1, assignee_filter))
      |> Enum.reject(&is_nil(&1))

    {:ok, issues}
  end

  defp decode_linear_response(%{"errors" => _errors}, _assignee_filter) do
    {:error, :linear_graphql_error}
  end

  defp decode_linear_response(_unknown, _assignee_filter) do
    {:error, :linear_unknown_payload}
  end

  defp decode_linear_page_response(
         %{
           "data" => %{
             "issues" => %{
               "nodes" => nodes,
               "pageInfo" => %{"hasNextPage" => has_next_page, "endCursor" => end_cursor}
             }
           }
         },
         assignee_filter
       ) do
    with {:ok, issues} <-
           decode_linear_response(
             %{"data" => %{"issues" => %{"nodes" => nodes}}},
             assignee_filter
           ) do
      {:ok, issues, %{has_next_page: has_next_page == true, end_cursor: end_cursor}}
    end
  end

  defp decode_linear_page_response(response, assignee_filter) do
    with {:ok, issues} <- decode_linear_response(response, assignee_filter) do
      {:ok, issues, %{has_next_page: false, end_cursor: nil}}
    end
  end

  defp next_page_cursor(%{has_next_page: true, end_cursor: end_cursor})
       when is_binary(end_cursor) and byte_size(end_cursor) > 0 do
    {:ok, end_cursor}
  end

  defp next_page_cursor(%{has_next_page: true}), do: {:error, :linear_missing_end_cursor}
  defp next_page_cursor(_), do: :done

  defp normalize_issue(issue, assignee_filter) when is_map(issue) do
    assignee = issue["assignee"]

    %Issue{
      id: issue["id"],
      identifier: issue["identifier"],
      title: issue["title"],
      description: issue["description"],
      priority: parse_priority(issue["priority"]),
      state: get_in(issue, ["state", "name"]),
      branch_name: issue["branchName"],
      url: issue["url"],
      assignee_id: assignee_field(assignee, "id"),
      blocked_by: extract_blockers(issue),
      labels: extract_labels(issue),
      assigned_to_worker: assigned_to_worker?(assignee, assignee_filter),
      created_at: parse_datetime(issue["createdAt"]),
      updated_at: parse_datetime(issue["updatedAt"])
    }
  end

  defp normalize_issue(_issue, _assignee_filter), do: nil

  defp assignee_field(%{} = assignee, field) when is_binary(field), do: assignee[field]
  defp assignee_field(_assignee, _field), do: nil

  defp assigned_to_worker?(_assignee, nil), do: true

  defp assigned_to_worker?(%{} = assignee, %{match_values: match_values})
       when is_struct(match_values, MapSet) do
    assignee
    |> assignee_id()
    |> then(fn
      nil -> false
      assignee_id -> MapSet.member?(match_values, assignee_id)
    end)
  end

  defp assigned_to_worker?(_assignee, _assignee_filter), do: false

  defp assignee_id(%{} = assignee), do: normalize_assignee_match_value(assignee["id"])

  defp routing_assignee_filter do
    case Config.settings!().tracker.assignee do
      nil ->
        {:ok, nil}

      assignee ->
        build_assignee_filter(assignee)
    end
  end

  defp build_assignee_filter(assignee) when is_binary(assignee) do
    case normalize_assignee_match_value(assignee) do
      nil ->
        {:ok, nil}

      "me" ->
        resolve_viewer_assignee_filter()

      normalized ->
        {:ok, %{configured_assignee: assignee, match_values: MapSet.new([normalized])}}
    end
  end

  defp resolve_viewer_assignee_filter do
    case graphql(@viewer_query, %{}) do
      {:ok, %{"data" => %{"viewer" => viewer}}} when is_map(viewer) ->
        case assignee_id(viewer) do
          nil ->
            {:error, :missing_linear_viewer_identity}

          viewer_id ->
            {:ok, %{configured_assignee: "me", match_values: MapSet.new([viewer_id])}}
        end

      {:ok, _body} ->
        {:error, :missing_linear_viewer_identity}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp normalize_assignee_match_value(value) when is_binary(value) do
    case value |> String.trim() do
      "" -> nil
      normalized -> normalized
    end
  end

  defp normalize_assignee_match_value(_value), do: nil

  defp extract_labels(%{"labels" => %{"nodes" => labels}}) when is_list(labels) do
    labels
    |> Enum.map(& &1["name"])
    |> Enum.reject(&is_nil/1)
    |> Enum.map(&String.downcase/1)
  end

  defp extract_labels(_), do: []

  defp extract_blockers(%{"inverseRelations" => %{"nodes" => inverse_relations}})
       when is_list(inverse_relations) do
    inverse_relations
    |> Enum.flat_map(fn
      %{"type" => relation_type, "issue" => blocker_issue}
      when is_binary(relation_type) and is_map(blocker_issue) ->
        if String.downcase(String.trim(relation_type)) == "blocks" do
          [
            %{
              id: blocker_issue["id"],
              identifier: blocker_issue["identifier"],
              state: get_in(blocker_issue, ["state", "name"])
            }
          ]
        else
          []
        end

      _ ->
        []
    end)
  end

  defp extract_blockers(_), do: []

  defp parse_datetime(nil), do: nil

  defp parse_datetime(raw) do
    case DateTime.from_iso8601(raw) do
      {:ok, dt, _offset} -> dt
      _ -> nil
    end
  end

  defp parse_priority(priority) when is_integer(priority), do: priority
  defp parse_priority(_priority), do: nil
end
