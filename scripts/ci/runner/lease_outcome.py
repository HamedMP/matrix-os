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
