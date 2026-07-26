import type { LifecycleState, RecoveryReason } from './contracts.js';
export type RuntimeEvidence = {
  deleteIntent: boolean;
  unit: 'active' | 'activating' | 'inactive' | 'failed' | 'missing';
  cgroupPopulated: boolean;
  keeperReady: boolean;
  keeperAlive: boolean;
  zellijResponsive: boolean;
  requiredProcessesInCgroup: boolean;
  descriptor: 'create-pending' | 'create-claimed' | 'recover-pending' | 'recover-claimed' | null;
  receipt: 'valid' | 'unsupported' | 'corrupt' | 'missing';
  resurrection: 'valid' | 'missing' | 'corrupt' | 'incompatible';
  priorState: LifecycleState | null;
  bootIdMatches: boolean;
};
export type ReconciledLifecycle = {
  lifecycleState: LifecycleState;
  recoverable: boolean;
  recoveryReason: RecoveryReason | null;
  recoveryMode: 'serialized' | 'fresh-shell' | null;
};
function result(
  lifecycleState: LifecycleState,
  recoverable: boolean,
  recoveryReason: RecoveryReason | null = null,
  recoveryMode: ReconciledLifecycle['recoveryMode'] = null,
): ReconciledLifecycle {
  return { lifecycleState, recoverable, recoveryReason, recoveryMode };
}
export function reconcileLifecycle(evidence: RuntimeEvidence): ReconciledLifecycle {
  if (evidence.deleteIntent) return result('deleting', false);
  if (evidence.receipt === 'unsupported') {
    return result('failed', false, 'unsupported_state');
  }
  if (evidence.unit === 'active') {
    if (
      evidence.cgroupPopulated &&
      evidence.keeperReady &&
      evidence.keeperAlive &&
      evidence.zellijResponsive &&
      evidence.requiredProcessesInCgroup
    ) {
      return result('live', false);
    }
    if (evidence.descriptor?.startsWith('recover-')) return result('recovering', false);
    return result('starting', false);
  }
  if (evidence.unit === 'activating') {
    if (evidence.descriptor?.startsWith('recover-')) return result('recovering', false);
    return result('starting', false);
  }
  if (evidence.receipt === 'corrupt') {
    return result('failed', false, 'metadata_corrupt');
  }
  if (evidence.descriptor?.startsWith('recover-')) return result('recovering', false);
  if (evidence.descriptor?.startsWith('create-')) return result('starting', false);
  if (evidence.receipt === 'valid') {
    const mode =
      evidence.resurrection === 'valid' ? 'serialized' : 'fresh-shell';
    const reason =
      evidence.resurrection === 'valid' ? null : 'history_unavailable';
    if (
      evidence.priorState === 'live' ||
      evidence.priorState === 'recovering'
    ) {
      return result('interrupted', true, reason, mode);
    }
    if (evidence.unit === 'failed') {
      return result('failed', true, 'startup_failed', mode);
    }
    if (evidence.priorState === 'failed') {
      return result('failed', true, 'startup_failed', mode);
    }
    if (evidence.priorState === 'exited') {
      return result('exited', true, reason, mode);
    }
    return result('recoverable', true, reason, mode);
  }
  if (evidence.cgroupPopulated) {
    // Missing metadata alone never authorizes terminating a populated cgroup.
    return result('interrupted', false, 'metadata_corrupt');
  }
  return result('failed', false, 'runtime_lost');
}
