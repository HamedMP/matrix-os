"""No native process or credentials needed for stale-turn polling regressions."""
import unittest
from probe_turns import await_turn


class FakeServer:
    def __init__(self, snapshots):
        self.snapshots = snapshots
        self.calls = 0

    def call(self, method, params):
        assert method == "thread/read"
        assert params == {"threadId": "thread", "includeTurns": True}
        snapshot = self.snapshots[min(self.calls, len(self.snapshots) - 1)]
        self.calls += 1
        return {"result": {"thread": {"turns": snapshot}}}


class PollExactStartedTurn(unittest.TestCase):
    def test_previous_completed_then_started_inprogress_then_started_completed(self):
        old = {"id": "previous", "status": "completed"}
        new = {"id": "started", "status": "completed"}
        server = FakeServer([[old], [old, {"id": "started", "status": "inProgress"}], [old, new]])
        self.assertEqual(await_turn(server, "thread", "started", max_polls=3, poll_interval=0), new)
        self.assertEqual(server.calls, 3)

    def test_previous_completed_only_times_out(self):
        server = FakeServer([[{"id": "previous", "status": "completed"}]])
        with self.assertRaises(TimeoutError):
            await_turn(server, "thread", "started", max_polls=3, poll_interval=0)
        self.assertEqual(server.calls, 3)


if __name__ == "__main__":
    unittest.main()
