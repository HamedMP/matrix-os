"""Trusted pre-workload availability outcomes, never candidate failure parsing."""
STAGES = {
    'queue_capacity': 'admission',
    'queue_timeout': 'admission',
    'host_capacity_unavailable': 'preflight',
    'docker_unavailable': 'preflight',
    'image_unavailable': 'preflight',
}


class InfrastructureUnavailable(RuntimeError):
    def __init__(self, reason):
        if reason not in STAGES:
            raise ValueError('Unknown infrastructure outcome')
        self.reason = reason
        self.stage = STAGES[reason]
        super().__init__('Trusted infrastructure unavailable: ' + reason)


# Coded host rejections stay red; only their fixed reason code reaches the controller.
REJECTIONS = frozenset({'result_cap'})
# Every terminal reason lease_manager.py can send, by record type. The controller
# repeats a reason only when it matches its record type (dedicated-ssh.mjs).
FAILURE_REASONS = {
    'failed': frozenset({'execution_failed', 'cleanup_failed', 'evidence_failed'}) | REJECTIONS,
    'cancelled': frozenset({'lease_revoked'}),
}


class HostRejection(ValueError):
    def __init__(self, reason):
        if reason not in REJECTIONS:
            raise ValueError('Unknown host rejection')
        self.reason = reason
        super().__init__('Host rejected lease: ' + reason)
