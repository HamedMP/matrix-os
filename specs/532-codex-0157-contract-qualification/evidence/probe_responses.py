"""Stateless current-turn selection for the local fake Responses provider."""
import hashlib
import json


def response_item(request):
    inputs = request.get("input", [])
    if not isinstance(inputs, list) or len(inputs) > 4096:
        raise ValueError("Fixture input exceeds bounded item count")
    users = [index for index, item in enumerate(inputs) if item.get("role") == "user"]
    if not users:
        raise ValueError("Fixture requires a current user input")
    boundary = users[-1]
    identity = json.dumps({"user": inputs[boundary], "ordinal": len(users)}, sort_keys=True, separators=(",", ":"))
    call_id = "call_scope_" + hashlib.sha256(identity.encode()).hexdigest()[:24]
    output_seen = any(item.get("type") == "function_call_output" and item.get("call_id") == call_id for item in inputs[boundary + 1:])
    if output_seen:
        return {"type": "message", "role": "assistant", "id": "msg_" + call_id, "content": [{"type": "output_text", "text": "mock answer"}]}
    return {"type": "function_call", "call_id": call_id, "namespace": "mcp__matrix_integrations", "name": "echo_scope", "arguments": "{}"}
