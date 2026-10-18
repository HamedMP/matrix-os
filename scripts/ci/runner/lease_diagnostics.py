"""Bounded advisory diagnostics; only the existing receipt grants qualification."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

MAX_BYTES = 16384
MAX_METRIC = 2**50
MEMORY_REASONS = {'unsupported_cgroup', 'unavailable', 'invalid_metrics', 'container_identity_mismatch'}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()


def _integer(value, maximum=MAX_METRIC):
    if type(value) is not int or not 0 <= value <= maximum:
        raise ValueError('Invalid bounded metric')
    return value


def _read_beneath(root, parts, limit=4096):
    if any(not re.fullmatch(r'[A-Za-z0-9_.:-]+', part) or part in ('.', '..') for part in parts):
        raise ValueError('Invalid metric component')
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        with os.fdopen(descriptor, 'rb') as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
                raise ValueError('Invalid metric file')
            value = source.read(limit + 1)
            if len(value) > limit:
                raise ValueError('Metric exceeds bound')
            return value.decode('ascii')
    finally:
        os.close(directory)


def _identity(execute, name, lease, digest):
    result = execute(['docker', 'inspect', name], timeout=5, cap=65536)
    if result.returncode or len(result.stdout) > 65536:
        raise ValueError('Container identity unavailable')
    rows = json.loads(result.stdout)
    if not isinstance(rows, list) or len(rows) != 1:
        raise ValueError('Container identity mismatch')
    row = rows[0]
    labels, state = row['Config']['Labels'], row['State']
    pid = state['Pid']
    if (labels.get('matrix-ci.lease') != lease or labels.get('matrix-ci.request') != digest
            or labels.get('matrix-ci.disposable') != 'true' or state.get('Running') is not True
            or type(pid) is not int or not 1 <= pid <= 2**31 - 1
            or not isinstance(row.get('Id'), str) or not re.fullmatch(r'[a-f0-9]{64}', row['Id'])):
        raise ValueError('Container identity mismatch')
    return pid, row['Id']


def _metric(text):
    if not re.fullmatch(r'[0-9]{1,16}\n?', text):
        raise ValueError('Invalid kernel metric')
    return _integer(int(text))


def sample_memory(execute, name, lease, digest, limit_bytes, *, proc_root=Path('/proc'), cgroup_root=Path('/sys/fs/cgroup')):
    """Host/kernel high-water mark, including tmpfs/cache; never candidate RSS."""
    try:
        original = _identity(execute, name, lease, digest)
    except (ValueError, KeyError, TypeError, IndexError, OSError):
        return dict(status='unavailable', reason='container_identity_mismatch')
    try:
        source = _read_beneath(proc_root, [str(original[0]), 'cgroup'])
        unified = [line[3:] for line in source.splitlines() if line.startswith('0::')]
        if len(unified) != 1:
            return dict(status='unavailable', reason='unsupported_cgroup')
        path = unified[0]
        if not path.startswith('/') or path == '/' or '//' in path:
            raise ValueError('Invalid cgroup scope')
        parts = path[1:].split('/')
        peak = _metric(_read_beneath(cgroup_root, [*parts, 'memory.peak']))
        limit = _metric(_read_beneath(cgroup_root, [*parts, 'memory.max']))
        if limit != limit_bytes:
            raise ValueError('Container memory limit differs')
        try:
            swap = _metric(_read_beneath(cgroup_root, [*parts, 'memory.swap.peak']))
        except FileNotFoundError:
            swap = None
        rows = _read_beneath(cgroup_root, [*parts, 'memory.events']).splitlines()
        if len(rows) > 20:
            raise ValueError('Memory event bound exceeded')
        events = {}
        for row in rows:
            key, value = row.split()
            if not re.fullmatch(r'[a-z_]{1,32}', key) or key in events:
                raise ValueError('Invalid memory events')
            events[key] = _metric(value)
        value = dict(status='available', measurement='cgroup-v2', peakBytes=peak, limitBytes=limit,
                     swapPeakBytes=swap, events=dict(oom=events['oom'], oomKill=events['oom_kill']))
        # Bind the sampled cgroup to the same still-running owned container/PID.
        if _identity(execute, name, lease, digest) != original or _read_beneath(proc_root, [str(original[0]), 'cgroup']) != source:
            return dict(status='unavailable', reason='container_identity_mismatch')
        return value
    except FileNotFoundError:
        return dict(status='unavailable', reason='unavailable')
    except (ValueError, KeyError, TypeError, IndexError, OSError, UnicodeError):
        return dict(status='unavailable', reason='invalid_metrics')


def _timeline(directory, phases, receipt):
    from contract import PHASES
    start = int(datetime.datetime.fromisoformat(receipt['startedUtc'].replace('Z', '+00:00')).timestamp() * 1000)
    finish = int(datetime.datetime.fromisoformat(receipt['finishedUtc'].replace('Z', '+00:00')).timestamp() * 1000)
    result = {}
    try:
        for lane, labels in PHASES.items():
            lines = _read_beneath(directory, ['timeline-' + lane + '.tsv'], MAX_BYTES).splitlines()
            if len(lines) != len(labels):
                raise ValueError('Incomplete timeline')
            for line in lines:
                label, before, after = line.split('\t')
                before, after = _metric(before), _metric(after)
                if (label not in labels or label in result or not start - 5000 <= before <= after <= finish + 5000
                        or after - before > 1_800_000 or abs(phases[label] - (after // 1000 - before // 1000)) > 1):
                    raise ValueError('Invalid phase interval')
                result[label] = dict(startedUnixMs=before, finishedUnixMs=after)
        return result
    except (ValueError, OSError, UnicodeError):
        # Legacy immutable images have no timelines; duration proof remains mandatory.
        print('Qualification diagnostic timeline unavailable', file=sys.stderr)
        return None


def create_diagnostics(receipt, proof, directory):
    from contract import PHASES
    expected = {label for labels in PHASES.values() for label in labels}
    phases = proof.get('phasesSeconds')
    if not isinstance(phases, dict) or set(phases) != expected:
        raise ValueError('Invalid validated phase inventory')
    phases = {key: _integer(value, 1800) for key, value in phases.items()}
    memory = dict(status='unavailable', reason='unavailable')
    try:
        observed = json.loads(_read_beneath(directory, ['diagnostic-memory.json']))
        if observed.get('status') == 'unavailable':
            if set(observed) != {'status', 'reason'} or observed['reason'] not in MEMORY_REASONS:
                raise ValueError('Invalid unavailable memory diagnostic')
        else:
            if (set(observed) != {'status', 'measurement', 'peakBytes', 'limitBytes', 'swapPeakBytes', 'events'}
                    or observed['status'] != 'available' or observed['measurement'] != 'cgroup-v2'
                    or set(observed['events']) != {'oom', 'oomKill'}):
                raise ValueError('Invalid memory diagnostic')
            for key in ('peakBytes', 'limitBytes'):
                _integer(observed[key])
            if observed['swapPeakBytes'] is not None:
                _integer(observed['swapPeakBytes'])
            for metric in observed['events'].values():
                _integer(metric)
        memory = observed
    except (OSError, ValueError, TypeError, KeyError, UnicodeError):
        print('Qualification memory diagnostic unavailable', file=sys.stderr)
    value = dict(schemaVersion=1, kind='qualification-diagnostics',
                 **{key: receipt[key] for key in ('leaseId', 'requestDigest', 'sourceSha', 'imageDigest', 'harnessDigest', 'queueSeconds', 'wallSeconds')},
                 receiptSha256=hashlib.sha256(canonical(receipt)).hexdigest(), phaseSeconds=phases,
                 phaseTimeline=_timeline(directory, phases, receipt), memory=memory)
    if len(canonical(value)) > MAX_BYTES:
        raise ValueError('Diagnostic export exceeds bound')
    return value
