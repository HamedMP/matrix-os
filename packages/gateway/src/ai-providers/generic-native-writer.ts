import type {ProviderWorkflowKey} from '@matrix-os/contracts';
import {createNativeProviderWriterLease} from './native-provider-writer-lease.js';
import {ProviderKeyPreflightError} from './provider-workflow-key.js';
import {NativeProviderWriteNotStartedError, NativeProviderWriteRestoredError} from './native-provider-profile-guard.js';
import {ProviderWorkflowError} from './provider-workflows.js';

export type GenericNativeWriterProfile = 'pi' | 'opencode' | 'hermes' | 'openclaw';
/** These native profiles have no canonical Terminal liveness observer. The
 * exclusive private marker survives gateway death; expiry never unlocks it.
 */
export function createGenericNativeWriter(homePath: string) {
  const leases = createNativeProviderWriterLease(homePath);
  const acquire = async (profile: GenericNativeWriterProfile) => {
    if (!['pi', 'opencode', 'hermes', 'openclaw'].includes(profile)) throw new ProviderWorkflowError('unavailable');
    return leases.acquire(profile);
  };
  return {
    acquire,
    async run<T>(profile: GenericNativeWriterProfile, operation: () => Promise<T>): Promise<T> {
      const release = await acquire(profile);
      try {
        const result = await operation();
        // Native adapters resolve only after real child/session drain and route
        // activation. Failure after launch deliberately retains the fence.
        await release();
        return result;
      } catch (error) {
        if (error instanceof ProviderKeyPreflightError || error instanceof NativeProviderWriteNotStartedError
          || error instanceof NativeProviderWriteRestoredError) await release();
        throw error;
      }
    },
  };
}
/** Production composition protects the whole native save/readback operation,
 * including the route commit, rather than only the foreground HTTP lifetime.
 */
export function guardGenericNativeKeys<T extends {verifyKey(input: ProviderWorkflowKey): Promise<void>}>(
  writer: ReturnType<typeof createGenericNativeWriter>, profile: GenericNativeWriterProfile, connection: T,
): T {
  return {...connection, verifyKey: input => writer.run(profile, () => connection.verifyKey(input))};
}
