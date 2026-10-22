#!/usr/bin/env python3
"""Read one bounded regular Docker archive member without extracting paths."""
import os
import sys
import tarfile

LIMIT = 50 * 1024 * 1024
destination, expected = sys.argv[1:]
if expected not in ('unit-cold.json', 'unit-warm.json', 'timing.tsv'):
    raise SystemExit('Unsupported artifact')
created = False
try:
    with tarfile.open(fileobj=sys.stdin.buffer, mode='r|') as archive:
        count = 0
        for entry in archive:
            count += 1
            # Never materialize directory paths, symlinks, or hardlinks on host.
            if count != 1 or not entry.isreg() or entry.name != expected or not 0 <= entry.size <= LIMIT:
                raise ValueError('Invalid artifact member')
            source = archive.extractfile(entry)
            if source is None:
                raise ValueError('Missing artifact contents')
            fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            created = True
            remaining = entry.size
            with os.fdopen(fd, 'wb') as output:
                while remaining:
                    chunk = source.read(min(65536, remaining))
                    if not chunk:
                        raise ValueError('Truncated artifact')
                    output.write(chunk)
                    remaining -= len(chunk)
        if count != 1:
            raise ValueError('Missing artifact')
except (OSError, ValueError, tarfile.TarError) as error:
    if created:
        os.unlink(destination)
    raise SystemExit('Artifact rejected') from error
