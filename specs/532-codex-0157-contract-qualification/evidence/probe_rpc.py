"""Bounded native fixture RPC reader; no account or global runtime state."""
import json
import os
import re
import selectors
import subprocess
import time
from collections import deque
from pathlib import Path


class Server:
    def __init__(self, binary, base, codex_home, mcp_log):
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C.UTF-8", "RUST_LOG": "codex_core=debug,codex_api=debug,reqwest=debug", "NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost"}
        env["HOME"] = str(base / "isolated-user-home")
        env["CODEX_HOME"] = str(codex_home)
        env["SPIKE_MCP_LOG"] = str(mcp_log)
        Path(env["HOME"]).mkdir(exist_ok=True)
        self.stderr_path = base / f"app-server-{time.time_ns()}.stderr"
        self.stderr = self.stderr_path.open("wb")
        self.proc = None
        self.selector = None
        try:
            self.proc = subprocess.Popen(
                [str(binary), "app-server", "--stdio"],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.stderr,
                cwd=str(base), env=env, bufsize=0,
            )
            self.selector = selectors.DefaultSelector()
            self.selector.register(self.proc.stdout, selectors.EVENT_READ)
            self.buffer = bytearray()
            self.next_id = 0
            self.notifications = deque()
            self.notification_bytes = 0
            self.call("initialize", {"clientInfo": {"name": "matrix-spike", "title": "Matrix Spike", "version": "1"}, "capabilities": {"experimentalApi": True}})
            self.notify("initialized", {})
        except BaseException:
            self.close()
            raise

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
        if self.proc is not None and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=4)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=4)
        if self.selector is not None:
            self.selector.close()
        if self.proc is not None:
            for pipe in (self.proc.stdin, self.proc.stdout):
                if pipe is not None:
                    pipe.close()
        self.stderr.close()
        lines = self.stderr_path.read_text(errors="replace").splitlines()
        interesting = [line for line in lines if re.search(r"error|failed|request|proxy|127\.0\.0\.1|mock|connection", line, re.IGNORECASE)]
        print("app-server-stderr-interesting:", "\n".join(interesting[-30:])[-9000:])

