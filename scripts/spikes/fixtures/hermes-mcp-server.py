"""Task-local JSON-RPC server; the client under test is unchanged upstream Hermes."""
import json
import os
import signal
import sys

log_path = sys.argv[1]
count = 0


def record(kind, **fields):
    global count
    count += 1
    if count > 100:
        raise RuntimeError("fixture event limit")
    with open(log_path, "a", encoding="utf8") as output:
        output.write(json.dumps(dict(kind=kind, pid=os.getpid(), **fields)) + "\n")


def stopped(signum, _frame):
    record("signal", signal=signum)
    raise SystemExit(0)


signal.signal(signal.SIGTERM, stopped)
signal.signal(signal.SIGINT, stopped)
record("started")
try:
    for _ in range(100):
        line = sys.stdin.readline(65537)
        if not line:
            break
        if len(line) > 65536:
            raise RuntimeError("fixture frame limit")
        request = json.loads(line)
        method = request.get("method")
        record("request", method=method)
        if "id" not in request:
            continue
        params = request.get("params") or {}
        result = {}
        if method == "initialize":
            result = dict(protocolVersion=params["protocolVersion"], capabilities={"tools": {}},
                          serverInfo={"name": "eng306-synthetic", "version": "1.0.0"})
        elif method == "tools/list":
            result = {"tools": [{"name": "echo", "description": "Return a synthetic fixture value",
                                  "inputSchema": {"type": "object", "properties": {"value": {"type": "string"}},
                                                  "required": ["value"]}}]}
        elif method == "tools/call":
            assert params["name"] == "echo"
            value = params["arguments"]["value"]
            record("tool_call", value=value)
            if value == "hold":
                continue  # Stay in the protocol read loop to observe cancellation/shutdown.
            assert value == "eng306"
            result = {"content": [{"type": "text", "text": "ENG306_REAL_MCP_RESULT"}], "isError": False}
        elif method in ("resources/list", "resources/templates/list", "prompts/list"):
            result = {{"resources/list": "resources", "resources/templates/list": "resourceTemplates",
                       "prompts/list": "prompts"}[method]: []}
        elif method != "ping":
            print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32601, "message": "Unknown method"}}), flush=True)
            continue
        print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
finally:
    record("exited")
