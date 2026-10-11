"""One-use post-lock grants and bounded authenticated live renewals."""
import secrets
import time
from lease_contract import canonical_digest


class LeaseProtocol:
    def __init__(self, envelope, now=time.monotonic):
        self.lease = envelope['leaseId']
        self.capability = envelope['capability']
        self.digest = canonical_digest(envelope['request'])
        self.now = now
        self.pending = None
        self.running = False
        self.closed = False
        self.deadline = None
        self.next_renewal = None

    def record(self, kind, **fields):
        return dict(protocolVersion=1, type=kind, leaseId=self.lease,
                    requestDigest=self.digest, **fields)

    def _challenge(self, kind):
        self.pending = secrets.token_hex(32)
        return self.record(kind, challenge=self.pending,
            deadlineUnixMs=int((time.time() + max(0, self.deadline - self.now())) * 1000))

    def locked(self):
        if self.closed or self.deadline is not None:
            raise ValueError('Lease lock challenge already issued')
        self.deadline = self.now() + 30
        return self._challenge('locked')

    def renewal(self):
        if self.closed or not self.running or self.expired() or self.pending is not None or self.now() < self.next_renewal:
            raise ValueError('Renewal unavailable')
        return self._challenge('renewal-required')

    def accept(self, value):
        keys = {'protocolVersion', 'type', 'leaseId', 'requestDigest', 'challenge', 'capability'}
        if self.closed or self.expired() or self.pending is None or not isinstance(value, dict) or set(value) != keys:
            raise ValueError('Grant/renewal expired or replayed')
        expected = 'renew' if self.running else 'grant'
        if (type(value['protocolVersion']) is not int or value['protocolVersion'] != 1
                or value['type'] != expected or value['leaseId'] != self.lease
                or value['requestDigest'] != self.digest
                or not isinstance(value['capability'], str) or not isinstance(value['challenge'], str)
                or not secrets.compare_digest(value['capability'], self.capability)
                or not secrets.compare_digest(value['challenge'], self.pending)):
            raise ValueError('Grant does not own this locked request')
        self.pending = None
        self.running = True
        self.deadline = self.now() + 120
        self.next_renewal = self.now() + 60

    def expired(self):
        return self.closed or (self.deadline is not None and self.now() >= self.deadline)

    def close(self):
        self.closed = True
        self.pending = None
        self.capability = ''
