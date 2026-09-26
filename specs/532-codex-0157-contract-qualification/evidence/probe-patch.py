"""No-paid exact Codex 0.157.1 app-server/MCP lifecycle qualification."""

import json
import os
import selectors
import subprocess
import sys
import tempfile
import time
import threading
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


SCRATCH = tempfile.TemporaryDirectory(prefix="eng26-codex-spike-")
BASE = Path(SCRATCH.name)
CODEX = Path(os.environ["CODEX_SPIKE_BINARY"])
assert subprocess.check_output([str(CODEX), "--version"], text=True).strip() == "codex-cli 0.157.1"
MCP = Path(__file__).parent / "fake_mcp.py"
CODEX_HOME = BASE / "isolated-codex-home"
CODEX_HOME.mkdir(exist_ok=True)
MCP_LOG = BASE / "mcp-events.jsonl"
MCP_LOG.unlink(missing_ok=True)


class MockHandler(BaseHTTPRequestHandler):
    request_count = 0

    def do_POST(self):
        MockHandler.request_count += 1
        request_number = MockHandler.request_count
        length = int(self.headers.get("content-length", "0"))
        request = json.loads(self.rfile.read(length))
        names = [tool.get("name") for tool in request.get("tools", [])]
        outputs = [item for item in request.get("input", []) if item.get("type") == "function_call_output"]
        with BASE.joinpath("mock-request-summary.jsonl").open("a") as log:
            log.write(json.dumps({"request_number": request_number, "path": self.path, "tool_names": names, "mcp_tool": next((tool for tool in request.get("tools", []) if tool.get("name") == "mcp__matrix_integrations"), None), "function_call_outputs": outputs}) + "\n")
        item = ({"type": "function_call", "call_id": f"call_scope_{request_number}", "namespace": "mcp__matrix_integrations", "name": "echo_scope", "arguments": "{}"}
                if request_number % 2 == 1 else
                {"type": "message", "role": "assistant", "id": f"msg_spike_{request_number}", "content": [{"type": "output_text", "text": "mock answer"}]})
        events = [
            {"type": "response.created", "response": {"id": f"resp_spike_{request_number}"}},
            {"type": "response.output_item.done", "item": item},
            {"type": "response.completed", "response": {"id": f"resp_spike_{request_number}", "usage": {"input_tokens": 0, "input_tokens_details": None, "output_tokens": 0, "output_tokens_details": None, "total_tokens": 0}}},
        ]
        body = "".join("event: " + e["type"] + "\ndata: " + json.dumps(e) + "\n\n" for e in events).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        return


mock = ThreadingHTTPServer(("127.0.0.1", 0), MockHandler)
threading.Thread(target=mock.serve_forever, daemon=True).start()
CODEX_HOME.joinpath("config.toml").write_text(
    f'model = "gpt-5.2"\nmodel_provider = "mock"\n[model_providers.mock]\nname = "Mock"\nbase_url = "http://127.0.0.1:{mock.server_port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n'
    f'\n[mcp_servers.matrix-integrations]\ncommand = "{sys.executable}"\nargs = ["{MCP}"]\n[mcp_servers.matrix-integrations.env]\nSCOPE_SENTINEL = "GLOBAL"\nSPIKE_MCP_LOG = "{MCP_LOG}"\n'
)


class Server:
    def __init__(self):
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C.UTF-8", "RUST_LOG": "codex_core=debug,codex_api=debug,reqwest=debug", "NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost"}
        env["HOME"] = str(BASE / "isolated-user-home")
        env["CODEX_HOME"] = str(CODEX_HOME)
        env["SPIKE_MCP_LOG"] = str(MCP_LOG)
        Path(env["HOME"]).mkdir(exist_ok=True)
        self.stderr_path = BASE / f"app-server-{time.time_ns()}.stderr"
        self.stderr = self.stderr_path.open("wb")
        self.proc = subprocess.Popen(
            [str(CODEX), "app-server", "--stdio"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.stderr,
            cwd=str(BASE), env=env, bufsize=0,
        )
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.proc.stdout, selectors.EVENT_READ)
        self.buffer = bytearray()
        self.next_id = 0
        self.call("initialize", {"clientInfo": {"name": "matrix-spike", "title": "Matrix Spike", "version": "1"}, "capabilities": {"experimentalApi": True}})
        self.notify("initialized", {})

    def send(self, item):
        self.proc.stdin.write((json.dumps(item, separators=(",", ":")) + "\n").encode())
        self.proc.stdin.flush()

    def notify(self, method, params):
        self.send({"method": method, "params": params})

    def call(self, method, params, timeout=20):
        self.next_id += 1
        wanted = self.next_id
        self.send({"id": wanted, "method": method, "params": params})
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            remaining = deadline - time.monotonic()
            for _key, _mask in self.selector.select(remaining):
                data = os.read(self.proc.stdout.fileno(), 65536)
                if not data:
                    raise RuntimeError(f"app-server closed during {method}")
                self.buffer.extend(data)
                while b"\n" in self.buffer:
                    line, _, rest = self.buffer.partition(b"\n")
                    self.buffer = bytearray(rest)
                    try:
                        msg = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if msg.get("id") == wanted:
                        return msg
        raise TimeoutError(method)

    def close(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=4)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=4)
        self.stderr.close()
        lines = self.stderr_path.read_text(errors="replace").splitlines()
        interesting = [line for line in lines if re.search(r"error|failed|request|proxy|127\.0\.0\.1|mock|connection", line, re.IGNORECASE)]
        print("app-server-stderr-interesting:", "\n".join(interesting[-30:])[-9000:])


def mcp_config(sentinel):
    return {"mcp_servers": {"matrix-integrations": {
        "command": sys.executable,
        "args": [str(MCP)],
        "env": {"SCOPE_SENTINEL": sentinel, "SPIKE_MCP_LOG": str(MCP_LOG)},
        "startup_timeout_sec": 5,
    }}}


def summary(response):
    if "error" in response:
        return {"error": response["error"]}
    result = response.get("result", {})
    if isinstance(result, dict) and "thread" in result:
        return {"threadId": result["thread"].get("id"), "sandbox": result.get("sandbox")}
    return result


def status(server, thread_id):
    for _ in range(10):
        result = server.call("mcpServerStatus/list", {"threadId": thread_id})
        data = result.get("result", {}).get("data", [])
        if any(item.get("name") == "matrix-integrations" and item.get("runtimeStatus") == "connected" for item in data):
            return result
        time.sleep(0.4)
    return result


def await_turn(server, thread_id):
    for _ in range(40):
        result = server.call("thread/read", {"threadId": thread_id, "includeTurns": True})
        turns = result.get("result", {}).get("thread", {}).get("turns", [])
        if turns and turns[-1].get("status") not in ("inProgress", "notStarted"):
            return turns[-1]
        time.sleep(0.25)
    return turns[-1] if turns else None


def checked_turn(server, thread_id, expected):
    turn = await_turn(server, thread_id)
    print("terminal-turn:", json.dumps(turn, separators=(",", ":")), flush=True)
    assert turn and turn["status"] == "completed", f"Turn did not complete: {turn}"
    calls = [item for item in turn["items"] if item["type"] == "mcpToolCall"]
    assert len(calls) == 1 and calls[0]["status"] == "completed", "MCP call did not complete"
    assert calls[0]["result"]["content"] == [{"type": "text", "text": expected}], "Unexpected MCP authority"
    return turn


def assert_sandbox(response):
    sandbox = summary(response)["sandbox"]
    assert sandbox["type"] == "workspaceWrite" and sandbox["networkAccess"] is False


def verify_init_failure_cleanup():
    class ForcedInitFailure(Server):
        def call(self, method, params, timeout=20):
            raise RuntimeError("forced fixture initialize failure")

    server = ForcedInitFailure.__new__(ForcedInitFailure)
    try:
        try:
            server.__init__()
            raise AssertionError("Expected constructor failure")
        except RuntimeError as error:
            assert str(error) == "forced fixture initialize failure"
        assert server.proc.poll() is not None, "Failed initialization left child running"
        assert server.selector.get_map() is None, "Selector leaked"
        assert server.proc.stdin.closed and server.proc.stdout.closed, "Child pipe leaked"
        assert server.stderr.closed, "Stderr file leaked"
        print("forced-init-cleanup: PASS", flush=True)
    finally:
        # Cleanup the deliberately failing RED case too.
        server.close()
        server.selector.close()
        server.proc.stdin.close()
        server.proc.stdout.close()


def exercise():
    first = Server()
    try:
        started = first.call("thread/start", {
            "cwd": str(BASE), "sandbox": "workspace-write", "approvalPolicy": "on-request",
            "config": mcp_config("A"),
        })
        assert_sandbox(started)
        print("start:", json.dumps(summary(started), separators=(",", ":")))
        thread_id = started.get("result", {}).get("thread", {}).get("id")
        if not thread_id:
            raise RuntimeError("thread/start failed")
        print("status-start:", json.dumps(summary(status(first, thread_id)), separators=(",", ":")))
        turn = first.call("turn/start", {"threadId": thread_id, "input": [{"type": "text", "text": "say mock answer"}]})
        print("turn-start:", json.dumps(summary(turn), separators=(",", ":")))
        print("first-turn:", json.dumps(checked_turn(first, thread_id, "A"), separators=(",", ":"))[:3000])
        loaded = first.call("thread/resume", {"threadId": thread_id, "excludeTurns": True, "config": mcp_config("B")})
        assert_sandbox(loaded)
        print("resume-loaded:", json.dumps(summary(loaded), separators=(",", ":")))
        print("status-loaded:", json.dumps(summary(status(first, thread_id)), separators=(",", ":")))
        first.call("turn/start", {"threadId": thread_id, "input": [{"type": "text", "text": "call echo_scope again"}]})
        print("loaded-turn:", json.dumps(checked_turn(first, thread_id, "A"), separators=(",", ":"))[:3000])
    finally:
        first.close()

    second = Server()
    try:
        cold = second.call("thread/resume", {"threadId": thread_id, "excludeTurns": True, "sandbox": "workspace-write", "approvalPolicy": "on-request", "config": mcp_config("C")})
        assert_sandbox(cold)
        print("resume-cold:", json.dumps(summary(cold), separators=(",", ":")))
        print("status-cold:", json.dumps(summary(status(second, thread_id)), separators=(",", ":")))
        second.call("turn/start", {"threadId": thread_id, "input": [{"type": "text", "text": "call echo_scope on cold resume"}]})
        print("cold-turn:", json.dumps(checked_turn(second, thread_id, "C"), separators=(",", ":"))[:3000])
    finally:
        second.close()


try:
    if "--verify-init-cleanup" in sys.argv:
        verify_init_failure_cleanup()
    else:
        exercise()
finally:
    print("mcp-events:", MCP_LOG.read_text() if MCP_LOG.exists() else "none", flush=True)
    print("mock-requests:", BASE.joinpath("mock-request-summary.jsonl").read_text() if BASE.joinpath("mock-request-summary.jsonl").exists() else "none", flush=True)
    mock.shutdown()
    mock.server_close()
    SCRATCH.cleanup()
