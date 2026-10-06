const RESPONSE_DIAGNOSTIC_VALUES = {
    mime: ['json', 'html', 'plain', 'other'],
    bodyRead: ['complete', 'oversize', 'cancelled', 'timeout', 'failed'],
    bodyShape: ['object', 'array', 'string', 'number', 'boolean', 'null', 'empty', 'non_json'],
    responseType: ['response', 'error', 'response.completed', 'response.failed', 'response.incomplete'],
    responseStatus: ['completed', 'failed', 'incomplete', 'in_progress', 'queued', 'cancelled'],
    errorCode: ['insufficient_quota', 'rate_limit_exceeded', 'invalid_api_key', 'model_not_found', 'invalid_request_error',
        'authentication_error', 'permission_denied', 'unsupported_parameter', 'unsupported_value', 'invalid_scope',
        'subscription_sharing_user_not_eligible', 'subscription_sharing_usage_limit_exceeded', 'subscription_sharing_usage_unavailable',
        'subscription_sharing_unsupported_capability', 'subscription_sharing_route_not_supported', 'subscription_sharing_invalid_user',
        'subscription_sharing_user_unavailable', 'chatpass_v2_scope_not_authorized', 'chatpass_v2_invalid_authorization_context'],
} as const;
export type PlanResponseDiagnostic = Partial<{ [K in keyof typeof RESPONSE_DIAGNOSTIC_VALUES]: typeof RESPONSE_DIAGNOSTIC_VALUES[K][number] }>
    & { sseFraming?: boolean; sseCompleted?: boolean; hasDetail?: boolean; hasError?: boolean; responseObject?: boolean };
/** Re-sanitize at the log boundary; never serialize arbitrary keys or values. */
export function safePlanResponseDiagnostic(value: unknown): PlanResponseDiagnostic {
    if (!value || typeof value !== 'object') return {};
    const input = value as Record<string, unknown>;
    const result: Record<string, string | boolean> = {};
    for (const [key, allowed] of Object.entries(RESPONSE_DIAGNOSTIC_VALUES)) {
        const item = input[key];
        if (typeof item === 'string' && (allowed as readonly string[]).includes(item)) result[key] = item;
    }
    for (const key of ['sseFraming', 'sseCompleted', 'hasDetail', 'hasError', 'responseObject']) {
        if (typeof input[key] === 'boolean') result[key] = input[key];
    }
    return result as PlanResponseDiagnostic;
}
/** Only fixed stages/categories/statuses reach trusted diagnostics, never provider text. */
export class PlanFailure extends Error {
    constructor(readonly stage: string, readonly category: string, readonly httpStatus?: number, readonly responseDiagnostic?: PlanResponseDiagnostic) {
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
    const diagnostic = failure?.responseDiagnostic ? safePlanResponseDiagnostic(failure.responseDiagnostic) : null;
    console.warn(`[chatgpt-plan] ${failure?.stage ?? stage}: ${category}${failure?.httpStatus !== undefined ? ` (http ${failure.httpStatus})` : ''}${diagnostic ? ` ${JSON.stringify(diagnostic)}` : ''}`);
}
