const RESPONSE_DIAGNOSTIC_VALUES = {
    mime: ['json', 'html', 'plain', 'other'],
    bodyRead: ['complete', 'oversize', 'cancelled', 'timeout', 'failed'],
    bodyShape: ['object', 'array', 'string', 'number', 'boolean', 'null', 'empty', 'non_json'],
    responseType: ['response', 'error', 'response.completed', 'response.failed', 'response.incomplete'],
    responseStatus: ['completed', 'failed', 'incomplete', 'in_progress', 'queued', 'cancelled'],
    incompleteReason: ['max_output_tokens', 'max_messages', 'content_filter', 'steered'],
    errorCode: ['server_error', 'invalid_prompt', 'invalid_image', 'invalid_image_format', 'invalid_base64_image', 'image_parse_error', 'image_too_large',
        'insufficient_quota', 'rate_limit_exceeded', 'invalid_api_key', 'model_not_found', 'invalid_request_error',
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
const LOCAL_FAILURE_CATEGORIES = {
    'invalid plan credential': 'invalid_plan_credential',
    'invalid identity': 'invalid_identity',
    'missing identity': 'missing_identity',
    'expired credential': 'expired_credential',
    'OS credential protection unavailable': 'credential_protection_unavailable',
    'invalid credential file': 'invalid_credential_file',
    'credential owner mismatch': 'credential_owner_mismatch',
    'not connected': 'not_connected',
    'response too large': 'response_oversize',
} as const;
function localFailureCategory(error: unknown): string {
    return error instanceof Error && Object.hasOwn(LOCAL_FAILURE_CATEGORIES, error.message)
        ? LOCAL_FAILURE_CATEGORIES[error.message as keyof typeof LOCAL_FAILURE_CATEGORIES] : 'local_failure';
}
/** Only fixed stages/categories/statuses reach trusted diagnostics, never provider text. */
export class PlanFailure extends Error {
    constructor(readonly stage: string, readonly category: string, readonly httpStatus?: number, readonly responseDiagnostic?: PlanResponseDiagnostic) {
        super(category);
        this.name = 'PlanFailure';
    }
}
/** Correlation is failure-only: strict UUIDs or the exact opaque canonical run grammar. */
function safeFailureCorrelation(value: unknown): Record<string, string> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const input = value as Record<string, unknown>;
    const result: Record<string, string> = {};
    for (const key of ['requestId', 'runId', 'computerId']) {
        const item = input[key];
        if (typeof item !== 'string' || item.length !== 36) continue;
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item)
            || key === 'runId' && /^run_[0-9a-f]{32}$/.test(item)) result[key] = item;
    }
    if (input.requestClass === 'interactive' || input.requestClass === 'background') result.requestClass = input.requestClass;
    if (!Object.keys(result).length) return null;
    result.observedAt = new Date().toISOString();
    return result;
}
export function logPlanFailure(stage: string, error: unknown, context?: unknown): void {
    const failure = error instanceof PlanFailure ? error : null;
    const category = failure?.category ?? (error instanceof DOMException ? error.name === 'AbortError' ? 'cancelled' : error.name === 'TimeoutError' ? 'timeout' : 'transport_error'
        : error instanceof Error && error.name === 'ZodError' ? 'invalid_schema'
            : error instanceof Error && [
                'JWTExpired', 'JWTClaimValidationFailed', 'JWSSignatureVerificationFailed', 'JWKSMultipleMatchingKeys', 'JWKSNoMatchingKey', 'JWSInvalid', 'JWTInvalid'
            ].includes(error.name) ? 'invalid_signed_identity'
                : error instanceof Error && [
                    'connection changed', 'source changed', 'credential changed', 'stale authorization'
                ].includes(error.message) ? 'stale_source'
                    : error instanceof Error && error.message === 'background not permitted' ? 'background_denied' : localFailureCategory(error));
    const diagnostic = failure?.responseDiagnostic ? safePlanResponseDiagnostic(failure.responseDiagnostic) : null;
    const correlation = safeFailureCorrelation(context);
    console.warn(`[chatgpt-plan] ${failure?.stage ?? stage}: ${category}${failure?.httpStatus !== undefined ? ` (http ${failure.httpStatus})` : ''}${diagnostic ? ` ${JSON.stringify(diagnostic)}` : ''}${correlation ? ` ${JSON.stringify({ correlation })}` : ''}`);
}
