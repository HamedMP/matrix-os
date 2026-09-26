"""Synthetic Responses item selection for the native fixture."""
request_count = 0


def response_item(request):
    global request_count
    request_count += 1
    return ({"type": "function_call", "call_id": f"call_scope_{request_count}", "namespace": "mcp__matrix_integrations", "name": "echo_scope", "arguments": "{}"}
            if request_count % 2 else
            {"type": "message", "role": "assistant", "id": f"msg_spike_{request_count}", "content": [{"type": "output_text", "text": "mock answer"}]})
