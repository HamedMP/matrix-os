"""Bounded polling for the exact native turn started by the fixture."""

import time


def await_turn(server, thread_id, turn_id, *, max_polls=40, poll_interval=0.25):
    completed = server.wait_completed(thread_id, turn_id)
    if completed.get("status") != "completed":
        return completed
    last_started = None
    for _ in range(max_polls):
        result = server.call("thread/read", {"threadId": thread_id, "includeTurns": True})
        turns = result.get("result", {}).get("thread", {}).get("turns", [])
        last_started = next((turn for turn in turns if turn.get("id") == turn_id), None)
        if last_started and last_started.get("status") == "completed":
            return last_started
        time.sleep(poll_interval)
    raise TimeoutError(f"Started turn {turn_id} did not finish: {last_started}")
