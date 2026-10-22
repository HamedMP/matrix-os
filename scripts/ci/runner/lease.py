#!/usr/bin/python3 -I
"""Fixed root CLI. SSH supplies owner capability through bounded stdin only."""
import os
from pathlib import Path
import sys
import time
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from lease_contract import hex_value, validate_envelope
from lease_config import read_owned_json, validate_config, verify_harness
from lease_io import ControlPipe
from lease_manager import LeaseManager
from lease_store import LeaseStore

STATE = Path('/var/lib/matrix-ci')
INSTALL = Path('/usr/local/libexec/matrix-ci')
CONFIG = Path('/etc/matrix-ci/runner.json')


def first_record(pipe):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        records = pipe.poll()
        if records:
            if len(records) != 1:
                raise ValueError('Multiple initial control records')
            return records[0]
        if pipe.eof:
            raise ValueError('Missing control envelope')
    raise TimeoutError('Initial control deadline')


def main():
    if (len(sys.argv) != 3 or sys.argv[1] not in ('run', 'cancel')
            or not hex_value(sys.argv[2], 32) or os.geteuid() != 0):
        print('Denied: fixed privileged lease command required', file=sys.stderr)
        return 64
    pipe = ControlPipe()
    value = first_record(pipe)
    lease = sys.argv[2]
    if sys.argv[1] == 'cancel':
        if (not isinstance(value, dict) or set(value) != {'protocolVersion', 'leaseId', 'capability', 'requestDigest'}
                or type(value['protocolVersion']) is not int or value['protocolVersion'] != 1 or value['leaseId'] != lease):
            raise ValueError('Cancellation envelope differs')
        LeaseStore(STATE / 'leases').cancel(lease, value['capability'], value['requestDigest'])
        pipe.emit(dict(protocolVersion=1, type='cancel-accepted', leaseId=lease, requestDigest=value['requestDigest']))
        return 0
    config = validate_config(read_owned_json(CONFIG))
    verify_harness(INSTALL, config['harnessDigest'])
    validate_envelope(value, config)
    if value['leaseId'] != lease:
        raise ValueError('Lease command does not bind envelope')
    # Imported only after all fixed installed inputs match the root approval.
    from qualification_host import QualificationHost
    # Capture trusted admission time before FIFO waiting; output allocation
    # still happens only after reservation and shared CPU lock acquisition.
    queue_started_epoch = time.time()
    host = None
    def preflight():
        nonlocal host
        # The manager reserves ownership and acquires the shared CPU lock
        # before this callback can allocate any qualification outputs.
        host = QualificationHost(STATE, lease, value['request'], queue_started_epoch=queue_started_epoch)
        return host.preflight()
    def cleanup():
        return True if host is None else host.cleanup()
    def verify():
        if host is None:
            raise ValueError('Qualification outputs not allocated')
        return host.receipt()
    return LeaseManager(value, config, STATE,
        ['/usr/bin/python3', '-I', str(INSTALL / 'qualification_host.py'), 'run', lease],
        cleanup=cleanup, verify=verify, preflight=preflight, pipe=pipe).run()


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        print('Lease admission rejected: ' + type(error).__name__, file=sys.stderr)
        raise SystemExit(70) from None
