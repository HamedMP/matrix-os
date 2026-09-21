defmodule SymphonyElixir.LinearClientTest do
  use ExUnit.Case
  alias SymphonyElixir.{Workflow, Linear.Client, Linear.RequestGate, Codex.DynamicTool}

  setup do
    file = Path.join(System.tmp_dir!(), "symphony-test-#{System.unique_integer([:positive])}.md")
    File.write!(file, "---\ntracker:\n  kind: linear\n  project_slug: test-project\n---\nTest")
    Workflow.set_workflow_file_path(file)
    start_supervised!({RequestGate, startup_delay_ms: 0})

    on_exit(fn ->
      Workflow.clear_workflow_file_path()
      File.rm!(file)
    end)

    %{workflow_path: file}
  end

  test "permanent HTTP errors suppress all repeated real client requests" do
    System.put_env("SYMPHONY_LINEAR_API_KEY", "test-direct-credential")
    on_exit(fn -> System.delete_env("SYMPHONY_LINEAR_API_KEY") end)
    owner = self()

    request = fn _, _ ->
      send(owner, :request)
      {:ok, %{status: 400, body: %{"error" => "secret-provider-detail"}}}
    end

    assert {:error, {:linear_api_status, 400}} =
             Client.graphql("query { viewer { id } }", %{}, request_fun: request)

    assert_received :request

    for _ <- 1..1000 do
      assert {:error, {:poll_deferred, :permanent, nil}} =
               Client.graphql("query { viewer { id } }", %{}, request_fun: request)
    end

    refute_received :request
  end

  test "unconfigured project never invokes the transport", %{workflow_path: file} do
    File.write!(file, "---\ntracker:\n  kind: linear\n---\nTest")

    assert {:error, :missing_linear_project_slug} =
             Client.graphql("query { viewer { id } }", %{},
               request_fun: fn _, _ -> flunk("unexpected request") end
             )
  end

  test "fixed operations cover workpad reads and edits without exposing query input" do
    specs = DynamicTool.tool_specs()
    assert Enum.any?(specs, &(&1["name"] == "linear"))
    refute Enum.any?(specs, &(&1["name"] == "linear_graphql"))

    for {operation, params} <- [
          {"get_issue", %{"issueId" => "abc"}},
          {"update_comment", %{"id" => "def", "body" => "notes"}}
        ] do
      assert {:ok, query} = SymphonyElixir.Linear.Adapter.operation_query(operation)
      assert {:ok, action} = SymphonyElixir.Linear.Adapter.bridge_action(query)
      assert action in ["symphony_get_issue", "symphony_update_comment"]

      result =
        DynamicTool.execute("linear", %{"operation" => operation, "params" => params},
          linear_client: fn q, p, _ ->
            assert q == query
            assert p == params
            {:ok, %{"data" => %{}}}
          end
        )

      assert result["success"] == true
    end
  end

  test "real Req bridge sends only typed params and preserves permanent status" do
    Application.ensure_all_started(:req)
    previous = Req.default_options()
    System.put_env("PLATFORM_INTERNAL_URL", "https://platform.test")
    System.put_env("MATRIX_HANDLE", "owner")
    System.put_env("UPGRADE_TOKEN", "test-upgrade-token")
    Req.default_options(plug: {Req.Test, __MODULE__})

    on_exit(fn ->
      Req.default_options(previous)

      for key <- ["PLATFORM_INTERNAL_URL", "MATRIX_HANDLE", "UPGRADE_TOKEN"],
          do: System.delete_env(key)
    end)

    owner = self()

    Req.Test.stub(__MODULE__, fn conn ->
      {:ok, body, conn} = Plug.Conn.read_body(conn)
      payload = Jason.decode!(body)
      assert payload["action"] == "symphony_poll"
      assert payload["params"]["projectSlug"] == "test-project"
      refute Map.has_key?(payload["params"], "query")
      assert conn.request_path == "/internal/containers/owner/integrations/call"
      send(owner, :bridge_request)

      if Process.get(:bridge_success) do
        Req.Test.json(conn, %{
          data: %{data: %{issues: %{nodes: [], pageInfo: %{hasNextPage: false, endCursor: nil}}}}
        })
      else
        Plug.Conn.send_resp(conn, 410, ~s({"error":"unsupported"}))
      end
    end)

    assert {:error, :unsupported_bridge_operation} = Client.graphql("query { secrets }", %{})
    refute_received :bridge_request
    Process.put(:bridge_success, true)
    assert {:ok, []} = Client.fetch_candidate_issues()
    assert_received :bridge_request
    Process.put(:bridge_success, false)
    assert {:error, {:linear_api_status, 410}} = Client.fetch_candidate_issues()
    assert_received :bridge_request

    for _ <- 1..100 do
      assert {:error, {:poll_deferred, :permanent, nil}} = Client.fetch_candidate_issues()
    end

    refute_received :bridge_request
  end

  test "workpad file sync uses fixed operations and refuses oversized or escaping files" do
    root = Path.join(System.tmp_dir!(), "symphony-workpad-#{System.unique_integer([:positive])}")
    File.mkdir_p!(root)
    on_exit(fn -> File.rm_rf!(root) end)
    file = Path.join(root, "workpad.md")
    File.write!(file, "progress notes")
    {:ok, query} = SymphonyElixir.Linear.Adapter.operation_query("create_comment")

    result =
      DynamicTool.execute("sync_workpad", %{"issue_id" => "abc", "file_path" => file},
        workspace: root,
        linear_client: fn q, params, _ ->
          assert q == query
          assert params["body"] == "progress notes"
          {:ok, %{"data" => %{"commentCreate" => %{"success" => true}}}}
        end
      )

    assert result["success"]
    File.write!(file, String.duplicate("x", 10001))

    for path <- [file, Path.join(root, "../outside.md")] do
      result =
        DynamicTool.execute("sync_workpad", %{"issue_id" => "abc", "file_path" => path},
          workspace: root,
          linear_client: fn _, _, _ -> flunk("unsafe file sent") end
        )

      refute result["success"]
    end
  end

  test "an explicitly configured credential preserves the legacy implicit project", %{
    workflow_path: file
  } do
    File.write!(file, "---\ntracker:\n  kind: linear\n---\nTest")
    System.put_env("SYMPHONY_LINEAR_API_KEY", "explicit-owner-key")
    on_exit(fn -> System.delete_env("SYMPHONY_LINEAR_API_KEY") end)
    assert SymphonyElixir.Config.settings!().tracker.project_slug == "matrix-os"
  end

  test "item-level GraphQL errors reject that operation without suspending polling" do
    System.put_env("SYMPHONY_LINEAR_API_KEY", "test-direct-credential")
    on_exit(fn -> System.delete_env("SYMPHONY_LINEAR_API_KEY") end)
    owner = self()

    request = fn payload, _ ->
      send(owner, {:request, payload["query"]})

      if payload["query"] == "stale comment" do
        {:ok,
         %{status: 200, body: %{"errors" => [%{"extensions" => %{"code" => "ENTITY_NOT_FOUND"}}]}}}
      else
        {:ok, %{status: 200, body: %{"data" => %{}}}}
      end
    end

    assert {:error, :linear_operation_error} =
             Client.graphql("stale comment", %{}, request_fun: request)

    assert_received {:request, "stale comment"}

    for _ <- 1..100 do
      assert {:error, :linear_operation_error} =
               Client.graphql("stale comment", %{}, request_fun: request)
    end

    refute_received {:request, "stale comment"}
    assert {:ok, _} = Client.graphql("poll", %{}, request_fun: request)
    assert_received {:request, "poll"}
  end

  test "Linear's documented HTTP 400 RATELIMITED response is transient" do
    System.put_env("SYMPHONY_LINEAR_API_KEY", "test-direct-credential")
    on_exit(fn -> System.delete_env("SYMPHONY_LINEAR_API_KEY") end)

    result =
      Client.graphql("poll", %{},
        request_fun: fn _, _ ->
          {:ok,
           %{status: 400, body: %{"errors" => [%{"extensions" => %{"code" => "RATELIMITED"}}]}}}
        end
      )

    assert {:error, {:linear_api_status, 429}} = result
    assert RequestGate.snapshot().outcome == :transient
  end

  test "typed tools validate their own per-operation parameters before either credential path" do
    for {operation, params} <- [
          {"get_issue", %{}},
          {"get_issue", %{"issueId" => "abc", "extra" => "bad"}},
          {"get_issue", %{"issueId" => "../../etc"}},
          {"create_comment", %{"issueId" => "abc", "body" => String.duplicate("x", 10001)}},
          {"update_comment", %{"id" => 2, "body" => "notes"}},
          {"resolve_state", %{"issueId" => "abc", "stateName" => ""}},
          {"update_state", %{"issueId" => "abc"}}
        ] do
      result =
        DynamicTool.execute("linear", %{"operation" => operation, "params" => params},
          linear_client: fn _, _, _ -> flunk("unvalidated params reached transport") end
        )

      refute result["success"]
    end
  end

  test "orchestrator uses the shared gate's single startup deadline" do
    stop_supervised!(RequestGate)
    gate = start_supervised!({RequestGate, startup_delay_ms: 60_000})
    {:ok, state} = SymphonyElixir.Orchestrator.init([])
    Process.cancel_timer(state.tick_timer_ref)
    assert abs(state.next_poll_due_at_ms - :sys.get_state(gate).due) < 50
    assert state.last_tracker_status == nil
  end
end
