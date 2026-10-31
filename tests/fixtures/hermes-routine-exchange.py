"""Real stdlib private transport; no native registry, source admission, provider or account."""
import concurrent.futures
import json
import runpy
import socket
import sys
import threading

resource = runpy.run_path(sys.argv[1])
request_id = "DE000000-0000-4000-8000-000000000710"
value = {"args": ["pause", "rt_" + "a" * 24, "--revision", "1", "--request-id", request_id]}


def native_text(result, args):
    text = resource["native_result"](result, args)
    assert isinstance(text, str), "native registry requires JSON text, not an ordinary dict"
    assert len(text.encode()) <= 131072
    return json.loads(text)


success = {"v": 1, "ok": True, "data": {"kind": "list", "routines": [], "truncated": False}}
assert native_text(success, {"args": ["list"]}) == success
assert native_text(resource["unknown"](value), value)["data"]["requestId"] == request_id
assert native_text(resource["unknown"]({"args": ["list"]}), {"args": ["list"]}) == resource["unknown"]({"args": ["list"]})
for invalid in ({"data": "x" * 131073}, {"data": "汉" * 65536}, {"data": float("nan")}, {"data": object()}, None):
    assert native_text(invalid, value) == resource["unknown"](value)
unicode_result = {"data": "汉" * 32768}
assert native_text(unicode_result, {"args": ["list"]}) == unicode_result


def pair():
    native, host = socket.socketpair()
    host.settimeout(2)
    exchange = resource["Exchange"](native.detach())
    host.sendall(b'{"type":"enable"}\n')
    assert host.recv(1024) == b'{"type":"enabled"}\n'
    # Read-loop enable is asynchronous. Synchronize without artificial provider activity.
    for _ in range(200):
        if exchange.enabled:
            return exchange, host
        threading.Event().wait(0.001)
    raise AssertionError("Private enable not consumed")


def context(number):
    return dict(zip(resource["IDS"], ["task", "compressed_" + str(number), "turn", "call_" + str(number), "api"]))


exchange, host = pair()
try:
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        a = pool.submit(exchange.call, value, context(1), lambda: False)
        b = pool.submit(exchange.call, {"args": ["list"]}, context(2), lambda: False)
        reader = host.makefile("rb")
        frames = [json.loads(reader.readline()), json.loads(reader.readline())]
        assert {frame["context"]["session_id"] for frame in frames} == {"compressed_1", "compressed_2"}
        for frame in reversed(frames):
            host.sendall((json.dumps({"type": "result", "id": frame["id"], "context": frame["context"], "result": json.dumps({"probe": frame["context"]})}) + "\n").encode())
        assert native_text(a.result(timeout=2), value)["probe"] == context(1)
        assert b.result(timeout=2)["probe"] == context(2)
        assert not exchange.pending
        reader.close()
finally:
    exchange.close()
    host.close()

for ending in ("EOF", "mismatched_context", "interrupt", "overflow"):
    exchange, host = pair()
    try:
        stop = threading.Event()
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(exchange.call, value, context(3), stop.is_set)
            reader = host.makefile("rb")
            frame = json.loads(reader.readline())
            if ending == "interrupt":
                stop.set()
                cancel = json.loads(reader.readline())
                assert cancel == {"type": "cancel", "id": frame["id"]}
                assert exchange.live  # Cancellation is invocation-scoped, never a claim worker stopped.
            elif ending == "mismatched_context":
                host.sendall((json.dumps({"type": "result", "id": frame["id"], "context": context(4), "result": "{}"}) + "\n").encode())
            elif ending == "overflow":
                try:
                    host.sendall(b"x" * 200000)
                except (BrokenPipeError, ConnectionResetError):
                    pass
            else:
                host.shutdown(socket.SHUT_WR)
            assert native_text(future.result(timeout=2), value) == {"v": 1, "ok": True, "data": {"kind": "unknown", "requestId": request_id, "disposition": "unknown", "reconcile": True}}
            assert not exchange.pending
            reader.close()
    finally:
        exchange.close()
        host.close()

exchange, host = pair()
try:
    with concurrent.futures.ThreadPoolExecutor(max_workers=9) as pool:
        waiting = [pool.submit(exchange.call, value, context(number), lambda: False) for number in range(8)]
        reader = host.makefile("rb")
        assert len([json.loads(reader.readline()) for _ in range(8)]) == 8
        capped = pool.submit(exchange.call, value, context(20), lambda: False)
        assert capped.result(timeout=2)["data"]["kind"] == "unknown"
        assert len(exchange.pending) == 8
        exchange.close()
        assert all(item.result(timeout=2)["data"]["requestId"] == request_id for item in waiting)
        assert not exchange.pending
        reader.close()
finally:
    exchange.close()
    host.close()

print(json.dumps({"ok": True, "tier": "production private exchange over actual socketpair", "cases": 7, "nativeResultText": True, "nativePublicApi": False}))
