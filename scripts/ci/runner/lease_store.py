"""Root-owned bounded lease replay barriers and owner-specific cancellation."""
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import secrets
import stat
import time
from lease_contract import canonical_digest, hex_value, MAX_RECORD

RETENTION_SECONDS = 7 * 86400


class LeaseStore:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = self.root.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('Lease registry must be private and owned')

    @contextlib.contextmanager
    def locked(self):
        fd = os.open(self.root / 'registry.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise ValueError('Invalid registry lock')
            deadline = time.monotonic() + 5
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise TimeoutError('Registry lock deadline')
                    time.sleep(0.02)
            yield
        finally:
            os.close(fd)

    def read(self, lease):
        if not hex_value(lease, 32):
            raise ValueError('Invalid lease identity')
        with os.fdopen(os.open(self.root / (lease + '.json'), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as file:
            info = os.fstat(file.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > MAX_RECORD:
                raise ValueError('Invalid owned lease record')
            data = file.read(MAX_RECORD + 1)
            if len(data) > MAX_RECORD:
                raise ValueError('Lease record exceeds bound')
            return json.loads(data)

    def _write(self, lease, value, create=False):
        data = json.dumps(value, sort_keys=True, separators=(',', ':')).encode()
        if len(data) > MAX_RECORD:
            raise ValueError('Lease state exceeds bound')
        temporary = self.root / ('.lease.' + secrets.token_hex(16) + '.tmp')
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(fd, 'wb') as file:
                file.write(data)
                file.flush()
                os.fsync(file.fileno())
            target = self.root / (lease + '.json')
            if create:
                os.link(temporary, target, follow_symlinks=False)
            else:
                self.read(lease)
                os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)

    def has_retained_outputs(self, lease):
        # Ownership must outlive result/log cleanup, including uncertain links.
        results = self.root.parent / 'results'
        try:
            info = results.lstat()
        except FileNotFoundError:
            info = None # Explicit expected absence before any result was created.
        if info is not None:
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
                return True
            try:
                (results / ('lease.' + lease)).lstat()
            except FileNotFoundError:
                result_present = False # This exact owned result was removed.
            else:
                result_present = True
            if result_present:
                return True
        try:
            (self.root.parent / (lease + '.log')).lstat()
        except FileNotFoundError:
            return False # No owned outputs remain; replay expiry is now safe.
        return True

    def records(self, now=None):
        now = time.time() if now is None else now
        entries = list(self.root.iterdir())
        if len(entries) > 300:
            raise ValueError('Lease registry directory cap')
        records = []
        for path in entries:
            if path.name == 'registry.lock':
                continue
            if __import__('re').fullmatch(r'\.lease\.[a-f0-9]{32}\.tmp', path.name):
                info = path.lstat()
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
                    raise ValueError('Invalid abandoned lease temporary')
                # Every writer holds this registry lock. No live writer owns it.
                path.unlink()
                continue
            if path.suffix != '.json' or not hex_value(path.stem, 32):
                raise ValueError('Unexpected registry entry')
            record = self.read(path.stem)
            if (record['status'] == 'completed' and record['created'] < now - RETENTION_SECONDS
                    and not self.has_retained_outputs(path.stem)):
                path.unlink()
            else:
                records.append(record)
        return records

    def reserve(self, envelope):
        digest = canonical_digest(envelope['request'])
        cap = hashlib.sha256(envelope['capability'].encode()).hexdigest()
        request = envelope['request']
        attempt = canonical_digest({k: request[k] for k in ('requestingRunId', 'requestingRunAttempt', 'controllerRunId', 'controllerRunAttempt')})
        with self.locked():
            records = self.records()
            if sum(r['status'] != 'completed' for r in records) >= 32 or sum(r['status'] == 'completed' for r in records) >= 256:
                raise ValueError('Lease registry capacity reached')
            if any(r['leaseId'] == envelope['leaseId'] or r['capabilityHash'] == cap or r['attempt'] == attempt for r in records):
                raise ValueError('Lease/capability/attempt replay rejected')
            order = max((r['queueOrder'] for r in records), default=0) + 1
            if order > 9007199254740991:
                raise ValueError('Queue order exhausted')
            self._write(envelope['leaseId'], dict(leaseId=envelope['leaseId'], queueOrder=order, requestDigest=digest,
                capabilityHash=cap, attempt=attempt, status='queued', cancelled=False, created=time.time()), create=True)

    def cancel(self, lease, capability, digest):
        if not hex_value(capability, 64) or not hex_value(digest, 64):
            raise ValueError('Invalid cancellation ownership')
        with self.locked():
            record = self.read(lease)
            if not secrets.compare_digest(record['capabilityHash'], hashlib.sha256(capability.encode()).hexdigest()) or record['requestDigest'] != digest:
                raise ValueError('Cancellation does not own this lease')
            if record['status'] != 'completed':
                record['cancelled'] = True
                self._write(lease, record)

    def is_cancelled(self, lease):
        return self.read(lease)['cancelled']

    def complete(self, lease):
        with self.locked():
            record = self.read(lease)
            record['status'] = 'completed'
            self._write(lease, record)

    def is_first(self, lease):
        with self.locked():
            active = [r for r in self.records() if r['status'] != 'completed' and not r['cancelled']]
            return bool(active) and min(active, key=lambda r: r['queueOrder'])['leaseId'] == lease
