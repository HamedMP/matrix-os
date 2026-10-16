import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import { ChatgptPlanDiagnosticSchema, type ChatgptPlanDiagnostic } from '../../shared/chatgpt-plan-ipc';
import { PlanFailure } from './diagnostics';

type Phase = ChatgptPlanDiagnostic['phase'];
type Category = ChatgptPlanDiagnostic['category'];
type Comparisons = Pick<ChatgptPlanDiagnostic, 'runtimeSlotMatches' | 'authGenerationMatches' | 'ownerMatches'>;

/** Internal annotation only. The original error remains its cause, never the IPC DTO. */
export class PlanStatusPhaseFailure extends Error {
    constructor(readonly phase: Phase, readonly category: Category, cause: unknown, readonly comparisons: Comparisons = {}) {
        super(cause instanceof Error ? cause.message : 'status unavailable', { cause });
    }
}
function category(error: unknown): Category {
    if (error instanceof PlanStatusPhaseFailure) return error.category;
    if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
    if (error instanceof DOMException && error.name === 'TimeoutError') return 'timeout';
    if (error instanceof z.ZodError) return 'invalid_data';
    if (error instanceof PlanFailure) {
        if (error.httpStatus === 401 || error.httpStatus === 403) return 'rejected';
        if (error.category === 'cancelled') return 'cancelled';
        if (error.category === 'timeout') return 'timeout';
        if (error.category === 'credential_rejected' || error.category === 'plan_scope_missing') return 'rejected';
        if (['http_error', 'network_error'].includes(error.category)) return 'unavailable';
        if (['invalid_json', 'invalid_catalog', 'response_oversize'].includes(error.category)) return 'invalid_data';
    }
    if (error instanceof Error && ['connection changed', 'source changed', 'credential changed', 'stale authorization'].includes(error.message)) return 'stale_session';
    return 'unknown';
}
/** One invocation owns this observer. No retained service state or diagnostic I/O. */
export function createPlanStatusObservation() {
    const correlationId = randomUUID();
    let comparisons: Comparisons = {};
    let diagnostic: ChatgptPlanDiagnostic | undefined;
    return {
        compare(value: Comparisons) { comparisons = { ...comparisons, ...value }; },
        fail(error: unknown, phase: Phase) {
            const failure = error instanceof PlanStatusPhaseFailure ? error : null;
            const http = error instanceof PlanFailure ? ChatgptPlanDiagnosticSchema.shape.httpStatus.safeParse(error.httpStatus) : null;
            diagnostic = Object.freeze(ChatgptPlanDiagnosticSchema.parse({
                phase: failure?.phase ?? phase, category: phase === 'response_schema' ? 'invalid_response' : category(error), at: new Date().toISOString(), correlationId,
                ...comparisons, ...failure?.comparisons,
                ...(http?.success && http.data !== undefined ? { httpStatus: http.data } : {}),
            }));
            return diagnostic;
        },
        get diagnostic() { return diagnostic; },
    };
}
export type PlanStatusObservation = ReturnType<typeof createPlanStatusObservation>;
