"""Bounded polling for the exact native turn started by the fixture."""

import time


def await_turn(server, thread_id, turn_id, *, max_polls=40, poll_interval=0.25):
    for _ in range(max_polls):
        result = server.call("thread/read", {"threadId": thread_id, "includeTurns": True})
        turns = result.get("result", {}).get("thread", {}).get("turns", [])
        if turns and turns[-1].get("status") not in ("inProgress", "notStarted"):
            return turns[-1]
        time.sleep(poll_interval)
    return turns[-1] if turns else None

