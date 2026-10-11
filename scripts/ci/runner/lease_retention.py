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
from lease_store import LeaseStore


def cleanup_results(root, now=None):
    root = Path(root)
    now = time.time() if now is None else now
    directory = root / 'results'
    if not directory.exists():
        return
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise ValueError('Untrusted result retention root')
    entries = list(directory.iterdir())
    if len(entries) > 512:
        raise ValueError('Result retention directory cap')
    store = LeaseStore(root / 'leases')
    rows = []
    with store.locked():
        for path in entries:
            match = re.fullmatch(r'lease\.([a-f0-9]{32})', path.name)
            info = path.lstat()
            if not match or not stat.S_ISDIR(info.st_mode):
                continue # Explicitly skip symlinks and unrelated manual evidence.
            if info.st_uid != os.getuid() or info.st_mode & 0o022:
                raise ValueError('Untrusted owned evidence directory')
            try:
                record = store.read(match[1])
            except FileNotFoundError:
                print('Retaining evidence with unknown lease ownership', file=sys.stderr)
                continue
            if record.get('status') == 'completed':
                rows.append((info.st_mtime, path, match[1]))
        rows.sort()
        for index, (mtime, path, lease) in enumerate(rows):
            if now - mtime <= 2700 or (now - mtime <= 7 * 86400 and index >= len(rows) - 20):
                continue
            # Parent and registry are exclusively root-owned; rmtree is FD-based
            # and does not traverse interior symlinks. No live lease is removed.
            if not shutil.rmtree.avoids_symlink_attacks:
                raise ValueError('Symlink-safe result removal unavailable')
            shutil.rmtree(path)
            log = root / (lease + '.log')
            try:
                info = log.lstat()
            except FileNotFoundError:
                continue # A queued/cancelled lease never allocated a log.
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise ValueError('Untrusted owned lease log')
            log.unlink()


if __name__ == '__main__':
    if os.geteuid() != 0 or len(sys.argv) != 1:
        raise SystemExit(64)
    cleanup_results(Path('/var/lib/matrix-ci'))
