import type { ChatgptPlanSession, ChatgptPlanStatus } from '../../shared/chatgpt-plan-ipc';
import { logPlanFailure } from './diagnostics';
import type { PlanStatusObservation } from './status-diagnostics';

/** Preserve ordinary status DTOs; observe only work this invocation already performs. */
export function createPlanStatusOperation<Bound>(deps: {
    bound(input: ChatgptPlanSession, observation?: PlanStatusObservation): Bound;
    ensure(value: Bound, observation?: PlanStatusObservation): Promise<void>;
    current(value: Bound, observation?: PlanStatusObservation): boolean;
    snapshot(value: Bound, observation?: PlanStatusObservation): ChatgptPlanStatus;
    generation(): number;
    needsCatalog(): boolean;
    readCatalog(value: Bound, signal: AbortSignal): Promise<void>;
    restartPeer(value: Bound): Promise<void>;
}) {
    return async (input: ChatgptPlanSession, observation?: PlanStatusObservation): Promise<ChatgptPlanStatus> => {
        let phase: ChatgptPlanDiagnosticPhase = 'session_binding';
        try {
            const value = deps.bound(input, observation);
            await deps.ensure(value, observation);
            const epoch = deps.generation();
            if (deps.needsCatalog()) {
                try {
                    phase = 'catalog';
                    await deps.readCatalog(value, AbortSignal.timeout(15000));
                    phase = 'peer';
                    await deps.restartPeer(value);
                } catch (error: unknown) {
                    if (!deps.current(value, observation) || epoch !== deps.generation()) throw error;
                    observation?.fail(error, phase);
                    logPlanFailure(phase, error);
                    // The existing catalog path owns fenced inference invalidation.
                }
            }
            phase = 'session_binding';
            return deps.snapshot(value, observation);
        } catch (error: unknown) {
            observation?.fail(error, phase);
            throw error;
        }
    };
}
type ChatgptPlanDiagnosticPhase = 'session_binding' | 'catalog' | 'peer';
