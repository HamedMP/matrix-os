"""Owned process-only Hermes public plugin. FD3 is held by its Gateway parent, never a bearer."""
import contextvars
import json
import os
import select
import socket
import sys
import threading
import time
import uuid

PIN = "d337b736aa1e8ebecfab043842d13e4a2d2f48a3"
TOOL = "matrix_routines"
LIMIT = 196608
IDS = ("task_id", "session_id", "turn_id", "tool_call_id", "api_request_id")
SCHEMA = {"name": TOOL, "description": "Invoke the fixed Matrix routines CLI. Mutations require the original request UUID. Owner approval, activation and background consent remain separate.",
          "parameters": {"type": "object", "additionalProperties": False, "required": ["args"], "properties": {
              "args": {"type": "array", "minItems": 1, "maxItems": 12, "items": {"type": "string", "minLength": 1, "maxLength": 2048}},
              "stdin": {"type": "string", "maxLength": 32768}}}}


def intent(value):
    if not isinstance(value, dict) or not set(value) <= {"args", "stdin"}:
        raise ValueError("Routine request unavailable")
    args = value.get("args")
    if not isinstance(args, list) or not 1 <= len(args) <= 12 or any(not isinstance(x, str) or not 1 <= len(x) <= 2048 for x in args):
        raise ValueError("Routine request unavailable")
    if "stdin" in value and (not isinstance(value["stdin"], str) or len(value["stdin"].encode()) > 32768):
        raise ValueError("Routine request unavailable")
    # The host's shared strict argv parser is authoritative; these checks bound native allocation.
    return json.loads(json.dumps(value))


def unknown(value):
    try:
        args = value["args"]
        request_id = args[args.index("--request-id") + 1]
        if str(uuid.UUID(request_id)).lower() != request_id.lower():
            raise ValueError("Invalid routine request UUID")
        if args[0] in ("propose", "pause", "resume", "archive"):
            return {"v": 1, "ok": True, "data": {"kind": "unknown", "requestId": request_id, "disposition": "unknown", "reconcile": True}}
    except (KeyError, ValueError, IndexError, TypeError):
        pass
    return {"v": 1, "error": {"code": "unavailable", "message": "Routine requests are temporarily unavailable."}}


def native_result(result, args):
    """Native registry accepts JSON text, not ordinary dicts. Keep private exchange DTOs separate."""
    try:
        if not isinstance(result, dict):
            raise ValueError("Routine result unavailable")
        text = json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        if len(text.encode()) <= 131072:
            return text
    except (TypeError, ValueError, OverflowError):
        pass  # A malformed/oversized result cannot become success or trigger a mutation retry.
    return json.dumps(unknown(args), ensure_ascii=False, separators=(",", ":"))


class Exchange:
    """One bounded duplex FD reader. No retry, reconnect, stdin interception or native RPC mutation."""
    def __init__(self, fd=3):
        os.set_inheritable(fd, False)
        self.pipe = socket.socket(fileno=fd)
        self.pipe.setblocking(False)
        self.lock = threading.RLock()
        self.write_lock = threading.Lock()
        self.pending = {}  # <=8, removed by each handler/finally and close.
        self.live = True
        self.enabled = False
        self.reader = threading.Thread(target=self.read, name="matrix-routines-replies", daemon=True)
        self.reader.start()

    def close(self):
        with self.lock:
            if not self.live:
                return
            self.live = False
            self.enabled = False
            for slot in self.pending.values():
                slot["event"].set()
        try:
            self.pipe.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass  # EOF is already a revoked channel, not proof of cancelled execution.
        self.pipe.close()

    def send(self, value):
        data = (json.dumps(value, separators=(",", ":")) + "\n").encode()
        if len(data) > LIMIT:
            self.close()
            return False
        deadline = time.monotonic() + 1
        with self.write_lock:
            try:
                while data and self.live:
                    if time.monotonic() >= deadline:
                        raise TimeoutError("Routine channel unavailable")
                    if select.select([], [self.pipe], [], 0.05)[1]:
                        data = data[self.pipe.send(data):]
                return not data
            except (OSError, ValueError, TimeoutError):
                self.close()
                return False

    def read(self):
        buffer = b""
        try:
            while self.live:
                if not select.select([self.pipe], [], [], 0.1)[0]:
                    continue
                data = self.pipe.recv(8192)
                if not data:
                    break
                buffer += data
                if len(buffer) > LIMIT:
                    raise ValueError("Routine frame too large")
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    frame = json.loads(line)
                    if not isinstance(frame, dict):
                        raise ValueError("Routine frame unavailable")
                    with self.lock:
                        if frame == {"type": "enable"} and not self.enabled:
                            self.enabled = True
                            self.send({"type": "enabled"})
                            continue
                        if set(frame) != {"type", "id", "context", "result"} or frame["type"] != "result" or not isinstance(frame["result"], str) or len(frame["result"].encode()) > 131072:
                            raise ValueError("Routine frame unavailable")
                        slot = self.pending.get(frame["id"])
                        if slot is None:
                            continue  # Late replies never acquire another invocation.
                        if slot["context"] != frame["context"] or slot["result"] is not None:
                            raise ValueError("Routine context unavailable")
                        slot["result"] = json.loads(frame["result"])
                        slot["event"].set()
        except (OSError, ValueError, TypeError, KeyError):
            pass  # Malformed/closed private channel fences every pending call below.
        finally:
            self.close()

    def call(self, value, context, interrupted):
        call_id = str(uuid.uuid4())
        slot = {"context": context, "event": threading.Event(), "result": None}
        with self.lock:
            if not self.live or not self.enabled or len(self.pending) >= 8 or interrupted():
                return unknown(value)
            self.pending[call_id] = slot
        deadline = time.monotonic() + 120
        try:
            if not self.send({"type": "call", "id": call_id, "context": context, "intent": value}):
                return unknown(value)
            while not slot["event"].wait(0.05):
                if interrupted() or time.monotonic() >= deadline or not self.live:
                    self.send({"type": "cancel", "id": call_id})
                    return unknown(value)
            if interrupted() or not self.live:
                self.send({"type": "cancel", "id": call_id})
                return unknown(value)
            return slot["result"] if isinstance(slot["result"], dict) else unknown(value)
        finally:
            with self.lock:
                self.pending.pop(call_id, None)


class PublicTool:
    def __init__(self, exchange):
        from hermes_cli.plugins import PluginManifest, PluginContext, discover_plugins, get_plugin_manager
        from hermes_constants import get_hermes_home, hermes_home_key
        from tools.registry import registry
        from tools.interrupt import is_interrupted
        from agent.delegation_context import is_delegated_child_context
        discover_plugins()  # Finish ordinary discovery; never force reload or use private loaders.
        self.manager = get_plugin_manager()
        self.scope = hermes_home_key(get_hermes_home())
        if self.manager.scope_key != self.scope or registry.current_scope_key() != self.scope:
            raise RuntimeError("Routine profile unavailable")
        self.exchange, self.closed, self.handles = exchange, False, []
        self.context = contextvars.ContextVar("matrix_routine_native_call", default=None)
        self.get_manager, self.registry = get_plugin_manager, registry
        self.interrupted, self.delegated = is_interrupted, is_delegated_child_context
        self.handler = self.dispatch  # Retain exact bound-method identity, not a fresh attribute wrapper.
        self.middleware = self.wrap
        if registry.get_entry(TOOL) is not None:
            raise RuntimeError("Routine tool already registered")
        ctx = PluginContext(PluginManifest(name="matrix-routines-owned", provides_tools=[TOOL]), self.manager)
        try:
            handle = ctx.register_tool(name=TOOL, toolset=TOOL, schema=SCHEMA, handler=self.handler, is_async=False, override=False)
            if handle is None:
                raise RuntimeError("Routine registration unavailable")
            self.handles.append(handle)
            self.handles.append(ctx.register_middleware("tool_execution", self.middleware))
            if not self.valid():
                raise RuntimeError("Routine registration unavailable")
        except Exception:
            self.dispose()
            raise

    def valid(self):
        entry = self.registry.get_entry(TOOL, scope=self.scope)
        return (not self.closed and self.get_manager() is self.manager and self.registry.current_scope_key() == self.scope
                and len(self.handles) == 2 and all(handle is not None and handle.active for handle in self.handles)
                and entry is not None and entry.handler is self.handler and not entry.is_async)

    def wrap(self, *, tool_name, args, next_call, **kwargs):
        if tool_name != TOOL:
            return next_call(args)
        native = tuple(kwargs.get(key) for key in IDS)
        if not self.valid() or self.delegated() or any(not isinstance(value, str) or not 1 <= len(value) <= 512 for value in native):
            return native_result(unknown(args), args)
        token = self.context.set(native)
        try:
            return next_call(args)  # Exactly one native continuation on this tool worker.
        finally:
            self.context.reset(token)

    def dispatch(self, args, *, task_id=None, session_id=None, user_task=None):
        native = self.context.get()
        if not self.valid() or self.delegated() or native is None or (task_id, session_id) != native[:2]:
            return native_result(unknown(args), args)  # Middleware may skip its own exception; handler independently denies.
        return native_result(self.exchange.call(intent(args), dict(zip(IDS, native)), self.interrupted), args)

    def dispose(self):
        if self.closed:
            return
        self.closed = True
        for handle in reversed(self.handles):
            if handle is not None:
                handle.dispose()
        self.handles.clear()
        self.exchange.close()


def install():
    exchange = Exchange()
    try:
        tool = PublicTool(exchange)
        if not exchange.send({"type": "ready", "version": 1, "pin": PIN}):
            tool.dispose()
            return None
        return tool
    except Exception as error:
        exchange.close()
        # Optional routine support must not replace/break unrelated Hermes Chat.
        print("[matrix-routines] Public API unavailable: " + type(error).__name__, file=sys.stderr)
        return None
