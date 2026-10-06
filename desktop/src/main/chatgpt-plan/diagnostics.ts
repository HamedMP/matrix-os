/** Only fixed stages/categories/statuses reach trusted diagnostics, never provider text. */
export class PlanFailure extends Error {
    constructor(readonly stage: string, readonly category: string, readonly httpStatus?: number) {
        super(category);
        this.name = 'PlanFailure';
    }
}
export function logPlanFailure(stage: string, error: unknown): void {
    const failure = error instanceof PlanFailure ? error : null;
    const category = failure?.category ?? (error instanceof DOMException ? error.name === 'AbortError' ? 'cancelled' : error.name === 'TimeoutError' ? 'timeout' : 'transport_error'
        : error instanceof Error && error.name === 'ZodError' ? 'invalid_schema'
            : error instanceof Error && [
                'JWTExpired', 'JWTClaimValidationFailed', 'JWSSignatureVerificationFailed', 'JWKSMultipleMatchingKeys', 'JWKSNoMatchingKey', 'JWSInvalid', 'JWTInvalid'
            ].includes(error.name) ? 'invalid_signed_identity'
                : error instanceof Error && [
                    'connection changed', 'source changed', 'credential changed', 'stale authorization'
                ].includes(error.message) ? 'stale_source'
                    : error instanceof Error && error.message === 'background not permitted' ? 'background_denied' : 'local_failure');
    console.warn(`[chatgpt-plan] ${failure?.stage ?? stage}: ${category}${failure?.httpStatus !== undefined ? ` (http ${failure.httpStatus})` : ''}`);
}
