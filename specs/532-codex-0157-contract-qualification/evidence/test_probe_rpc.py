"""Synthetic stdio peer tests actual fixture reader ordering and bounds."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from probe_rpc import Server


class ReaderEvents(unittest.TestCase):
    def run_peer(self, before):
        with tempfile.TemporaryDirectory(prefix="codex-rpc-control-") as directory:
            base = Path(directory)
            binary = base / "peer"
            events = [
                {"method": "turn/completed", "params": {"threadId": "thread", "turn": {"id": "previous", "status": "completed"}}},
                {"method": "turn/completed", "params": {"threadId": "other", "turn": {"id": "started", "status": "completed"}}},
                {"method": "turn/completed", "params": {"threadId": "thread", "turn": {"id": "started", "status": "completed"}}},
            ]
            binary.write_text(f"#!{sys.executable}\n" +
                "import os,json,sys\n" + f"events={events!r}\n" +
                "for line in sys.stdin:\n" +
                " message=json.loads(line)\n" +
                " if 'id' not in message: continue\n" +
                " response={'id':message['id'],'result':{}}\n" +
                f" frames=events+[response] if {before!r} else [response]+events\n" +
                " os.write(1,(''.join(json.dumps(frame)+'\n' for frame in frames)).encode())\n")
            binary.chmod(0o700)
            server = Server(binary, base, base / "home", base / "mcp-log")
            try:
                completed = server.wait_completed("thread", "started", timeout=1)
                self.assertEqual(completed, {"id": "started", "status": "completed"})
                self.assertEqual(len(server.notifications), 2)
                for _ in range(300):
                    server._retain({"method": "synthetic", "data": "x" * 5000})
                self.assertLessEqual(len(server.notifications), 256)
                self.assertLessEqual(server.notification_bytes, 1024 * 1024)
            finally:
                server.close()

    def test_completion_before_rpc_response_is_retained(self):
        self.run_peer(True)

    def test_completion_after_response_in_same_chunk_is_read(self):
        self.run_peer(False)


if __name__ == "__main__":
    unittest.main()
