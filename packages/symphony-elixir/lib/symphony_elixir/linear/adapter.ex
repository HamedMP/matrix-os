defmodule SymphonyElixir.Linear.Adapter do
  @moduledoc """
  Linear-backed tracker adapter.
  """

  @behaviour SymphonyElixir.Tracker

  alias SymphonyElixir.Linear.Client

  @create_comment_mutation """
  mutation SymphonyCreateComment($issueId: String!, $body: String!) {
    commentCreate(input: {issueId: $issueId, body: $body}) {
      success
      comment { id url }
    }
  }
  """

  @update_state_mutation """
  mutation SymphonyUpdateIssueState($issueId: String!, $stateId: String!) {
    issueUpdate(id: $issueId, input: {stateId: $stateId}) {
      success
    }
  }
  """

  @state_lookup_query """
  query SymphonyResolveStateId($issueId: String!, $stateName: String!) {
    issue(id: $issueId) {
      team {
        states(filter: {name: {eq: $stateName}}, first: 1) {
          nodes {
            id
          }
        }
      }
    }
  }
  """

  @get_issue_query """
  query SymphonyGetIssue($issueId: String!) {
    issue(id: $issueId) {
      id identifier title description url state { name }
      comments(first: 50) { nodes { id body url } }
      team { states(first: 50) { nodes { id name } } }
    }
  }
  """

  @update_comment_mutation """
  mutation SymphonyUpdateComment($id: String!, $body: String!) {
    commentUpdate(id: $id, input: {body: $body}) { success comment { id url } }
  }
  """

  @operation_params %{
    "get_issue" => %{"issueId" => :id},
    "create_comment" => %{"issueId" => :id, "body" => :body},
    "update_comment" => %{"id" => :id, "body" => :body},
    "resolve_state" => %{"issueId" => :id, "stateName" => :text},
    "update_state" => %{"issueId" => :id, "stateId" => :id}
  }

  def operation_params_schemas do
    Enum.map(@operation_params, fn {_operation, fields} ->
      %{
        "type" => "object",
        "additionalProperties" => false,
        "required" => Map.keys(fields),
        "properties" => Map.new(fields, fn {key, type} -> {key, param_schema(type)} end)
      }
    end)
  end

  def validate_operation_params(operation, params) when is_map(params) do
    case @operation_params[operation] do
      fields when is_map(fields) ->
        if Enum.sort(Map.keys(fields)) == Enum.sort(Map.keys(params)) and
             Enum.all?(fields, fn {key, type} -> valid_param?(type, params[key]) end),
           do: :ok,
           else: {:error, :invalid_linear_operation_params}

      _ ->
        {:error, :unsupported_bridge_operation}
    end
  end

  def validate_operation_params(_, _), do: {:error, :invalid_linear_operation_params}

  defp param_schema(:id),
    do: %{
      "type" => "string",
      "minLength" => 1,
      "maxLength" => 256,
      "pattern" => "^[A-Za-z0-9][A-Za-z0-9_-]*$"
    }

  defp param_schema(:text), do: %{"type" => "string", "minLength" => 1, "maxLength" => 256}
  defp param_schema(:body), do: %{"type" => "string", "minLength" => 1, "maxLength" => 10000}

  defp valid_param?(:id, value) when is_binary(value),
    do: byte_size(value) <= 256 and Regex.match?(~r/^[A-Za-z0-9][A-Za-z0-9_-]*$/, value)

  defp valid_param?(type, value) when is_binary(value) do
    max_length = if type == :body, do: 10000, else: 256
    byte_size(value) <= max_length * 4 and String.length(value) in 1..max_length
  end

  defp valid_param?(_, _), do: false

  def operation_query("get_issue"), do: {:ok, @get_issue_query}
  def operation_query("create_comment"), do: {:ok, @create_comment_mutation}
  def operation_query("update_comment"), do: {:ok, @update_comment_mutation}
  def operation_query("resolve_state"), do: {:ok, @state_lookup_query}
  def operation_query("update_state"), do: {:ok, @update_state_mutation}
  def operation_query(_), do: {:error, :unsupported_bridge_operation}

  # Exact local documents map to fixed platform operations; dynamic GraphQL is
  # available only with an owner's explicit direct Linear credential.
  def bridge_action(@create_comment_mutation), do: {:ok, "symphony_create_comment"}
  def bridge_action(@state_lookup_query), do: {:ok, "symphony_resolve_state"}
  def bridge_action(@update_state_mutation), do: {:ok, "symphony_update_state"}
  def bridge_action(@get_issue_query), do: {:ok, "symphony_get_issue"}
  def bridge_action(@update_comment_mutation), do: {:ok, "symphony_update_comment"}
  def bridge_action(_), do: {:error, :unsupported_bridge_operation}

  @spec fetch_candidate_issues() :: {:ok, [term()]} | {:error, term()}
  def fetch_candidate_issues, do: client_module().fetch_candidate_issues()

  @spec fetch_issues_by_states([String.t()]) :: {:ok, [term()]} | {:error, term()}
  def fetch_issues_by_states(states), do: client_module().fetch_issues_by_states(states)

  @spec fetch_issue_states_by_ids([String.t()]) :: {:ok, [term()]} | {:error, term()}
  def fetch_issue_states_by_ids(issue_ids),
    do: client_module().fetch_issue_states_by_ids(issue_ids)

  @spec create_comment(String.t(), String.t()) :: :ok | {:error, term()}
  def create_comment(issue_id, body) when is_binary(issue_id) and is_binary(body) do
    with {:ok, response} <-
           client_module().graphql(@create_comment_mutation, %{issueId: issue_id, body: body}),
         true <- get_in(response, ["data", "commentCreate", "success"]) == true do
      :ok
    else
      false -> {:error, :comment_create_failed}
      {:error, reason} -> {:error, reason}
      _ -> {:error, :comment_create_failed}
    end
  end

  @spec update_issue_state(String.t(), String.t()) :: :ok | {:error, term()}
  def update_issue_state(issue_id, state_name)
      when is_binary(issue_id) and is_binary(state_name) do
    with {:ok, state_id} <- resolve_state_id(issue_id, state_name),
         {:ok, response} <-
           client_module().graphql(@update_state_mutation, %{issueId: issue_id, stateId: state_id}),
         true <- get_in(response, ["data", "issueUpdate", "success"]) == true do
      :ok
    else
      false -> {:error, :issue_update_failed}
      {:error, reason} -> {:error, reason}
      _ -> {:error, :issue_update_failed}
    end
  end

  defp client_module do
    Application.get_env(:symphony_elixir, :linear_client_module, Client)
  end

  defp resolve_state_id(issue_id, state_name) do
    with {:ok, response} <-
           client_module().graphql(@state_lookup_query, %{
             issueId: issue_id,
             stateName: state_name
           }),
         state_id when is_binary(state_id) <-
           get_in(response, ["data", "issue", "team", "states", "nodes", Access.at(0), "id"]) do
      {:ok, state_id}
    else
      {:error, reason} -> {:error, reason}
      _ -> {:error, :state_not_found}
    end
  end
end
