"""Bounded JSONL controller pipe. Candidate output never uses this channel."""
import json
import os
import select
import time
from lease_contract import MAX_RECORD


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError('Duplicate JSON field')
        value[key] = item
    return value


def decode(data):
    return json.loads(data.decode('utf8'), object_pairs_hook=unique_object,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('Nonfinite JSON')))


class ControlPipe:
    def __init__(self, input_fd=0, output_fd=1):
        self.input = input_fd
        self.output = output_fd
        self.buffer = bytearray()
        self.received = 0
        self.sent = 0
        self.eof = False

    def poll(self, wait=0.05):
        if not self.eof and select.select([self.input], [], [], wait)[0]:
            data = os.read(self.input, 4096)
            if not data:
                self.eof = True
            self.received += len(data)
            if self.received > 1024 * 1024:
                raise ValueError('Controller input exceeds bound')
            self.buffer.extend(data)
        records = []
        while b'\n' in self.buffer:
            end = self.buffer.index(b'\n')
            if end > MAX_RECORD:
                raise ValueError('Controller record exceeds bound')
            data = bytes(self.buffer[:end])
            del self.buffer[:end + 1]
            records.append(decode(data))
        if len(self.buffer) > MAX_RECORD or (self.eof and self.buffer):
            raise ValueError('Incomplete/oversized controller record')
        return records

    def emit(self, value):
        data = json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False,
                          allow_nan=False).encode('utf8') + b'\n'
        self.sent += len(data)
        if len(data) > 32768 or self.sent > 1024 * 1024:
            raise ValueError('Controller output exceeds bound')
        deadline = time.monotonic() + 5
        # Nonblocking writes bound a disconnected/unresponsive controller.
        blocking = os.get_blocking(self.output)
        os.set_blocking(self.output, False)
        try:
            while data:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not select.select([], [self.output], [], remaining)[1]:
                    raise TimeoutError('Controller output deadline')
                try:
                    data = data[os.write(self.output, data):]
                except BlockingIOError:
                    continue
        finally:
            os.set_blocking(self.output, blocking)
