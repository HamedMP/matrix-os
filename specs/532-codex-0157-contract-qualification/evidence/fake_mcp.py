import json
import os
import sys


def send(message):
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


for line in sys.stdin:
    try:
        message = json.loads(line)
    except json.JSONDecodeError:
        continue
    method = message.get("method")
    with open(os.environ["SPIKE_MCP_LOG"], "a", encoding="utf-8") as log:
        log.write(json.dumps({"method": method, "sentinel": os.environ.get("SCOPE_SENTINEL"), "scoped_token_present": "MATRIX_AGENT_INTEGRATIONS_TOKEN" in os.environ}) + "\n")
    if "id" not in message:
        continue
    if method == "initialize":
        result = {
            "protocolVersion": message.get("params", {}).get("protocolVersion", "2025-03-26"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "matrix-spike", "version": "0.0.0"},
        }
    elif method == "tools/list":
        result = {"tools": [{
            "name": "echo_scope",
            "description": "Return a harmless sentinel.",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
            "annotations": {"readOnlyHint": True},
        }]}
    elif method == "tools/call":
        result = {"content": [{"type": "text", "text": os.environ.get("SCOPE_SENTINEL", "missing")}], "isError": False}
    else:
        result = {}
    send({"jsonrpc": "2.0", "id": message["id"], "result": result})
