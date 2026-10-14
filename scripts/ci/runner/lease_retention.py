"""Recurring root-owned completed evidence retention; uncertain/live state survives."""
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import time
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from lease_store import LeaseStore, RETENTION_SECONDS


def remove_log(path, older_than=None):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return # Explicit expected absence for queued/cancelled leases.
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('Untrusted owned lease log')
    if older_than is None or info.st_mtime < older_than:
        path.unlink()


RESULT_ENTRY_CAP = 512
LEASE_RESULT_CAP = 32


def lease_directories(entries):
    """Yield (path, lease, lstat) for the entries named and shaped like lease result directories."""
    for path in entries:
        match = re.fullmatch(r'lease\.([a-f0-9]{32})', path.name)
        if not match:
            continue # Unrelated manual evidence is never inspected.
        try:
            info = path.lstat()
        except FileNotFoundError:
            continue # Removed after listing; it no longer holds a slot.
        if stat.S_ISDIR(info.st_mode):
            yield path, match[1], info # Symlinks are never followed or counted.


def cleanup_results(root, now=None):
    root = Path(root)
    now = time.time() if now is None else now
    directory = root / 'results'
    if not directory.exists():
        return 0, 0
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise ValueError('Untrusted result retention root')
    store = LeaseStore(root / 'leases')
    rows = []
    with store.locked():
        entries = list(directory.iterdir())
        leases = 0
        for path, lease, info in lease_directories(entries):
            leases += 1
            if info.st_uid != os.getuid() or info.st_mode & 0o022:
                raise ValueError('Untrusted owned evidence directory')
            try:
                record = store.read(lease)
            except FileNotFoundError:
                print('Retaining evidence with unknown lease ownership', file=sys.stderr)
                continue
            if record.get('status') == 'completed':
                rows.append((info.st_mtime, path, lease))
        rows.sort()
        for index, (mtime, path, lease) in enumerate(rows):
            if now - mtime <= 2700 or (now - mtime <= RETENTION_SECONDS and index >= len(rows) - 20):
                continue
            # Parent and registry are exclusively root-owned; rmtree is FD-based
            # and does not traverse interior symlinks. No live lease is removed.
            if not shutil.rmtree.avoids_symlink_attacks:
                raise ValueError('Symlink-safe result removal unavailable')
            shutil.rmtree(path)
            leases -= 1
            log = root / (lease + '.log')
            remove_log(log)
        # Retry a completed log left after interrupted evidence removal. Its
        # ownership record was retained; active/unknown output is never guessed.
        for record in store.records(now=now):
            if record.get('status') != 'completed':
                continue
            lease = record['leaseId']
            try:
                (directory / ('lease.' + lease)).lstat()
            except FileNotFoundError:
                remove_log(root / (lease + '.log'), older_than=now-RETENTION_SECONDS)
        # Still under the same registry flock: only resource-free expired
        # replay tombstones can disappear after proven owned-output removal.
        store.records(now=now)
        # Counted under the registry flock after pruning. Relisting (no lstat)
        # drops entries pruned here or removed by an operator meanwhile.
        return len(list(directory.iterdir())), leases


if __name__ == '__main__':
    if os.geteuid() != 0 or len(sys.argv) != 1:
        raise SystemExit(64)
    usage = cleanup_results(Path('/var/lib/matrix-ci'))
    # Retention never removes manual evidence or leases it cannot prove complete.
    if usage and (usage[0] >= RESULT_ENTRY_CAP or usage[1] >= LEASE_RESULT_CAP):
        print('Result directory is full; new leases fail with result_cap until results are pruned', file=sys.stderr)
