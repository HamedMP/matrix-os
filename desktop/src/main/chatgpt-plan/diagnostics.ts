const RESPONSE_DIAGNOSTIC_VALUES = {
    streamReason: ['body_missing', 'reader_unavailable', 'body_read', 'utf8_decode', 'frame_fields', 'event_json', 'event_schema',
        'event_name', 'output_delta', 'terminal_identity', 'event_after_terminal', 'upstream_failed', 'upstream_incomplete',
        'upstream_error', 'done_order', 'trailing_frame', 'missing_completion', 'frame_limit', 'terminal_limit', 'pending_limit'],
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
const NETWORK_DIAGNOSTIC_VALUES = {
    errorName: ['Error', 'TypeError', 'RangeError', 'AggregateError', 'DOMException', 'AbortError', 'TimeoutError',
        'SocketError', 'ConnectTimeoutError', 'HeadersTimeoutError', 'BodyTimeoutError'],
    code: ['UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
        'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH',
        'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE', 'unknown'],
    chromiumCode: ['ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_TIMED_OUT', 'ERR_NAME_NOT_RESOLVED', 'ERR_ADDRESS_UNREACHABLE',
        'ERR_CONNECTION_RESET', 'ERR_CONNECTION_CLOSED', 'ERR_CONNECTION_ABORTED', 'ERR_NETWORK_CHANGED',
        'ERR_TIMED_OUT', 'ERR_INTERNET_DISCONNECTED', 'ERR_EMPTY_RESPONSE', 'ERR_PROXY_CONNECTION_FAILED',
        'ERR_TUNNEL_CONNECTION_FAILED', 'ERR_CERT_AUTHORITY_INVALID', 'ERR_CERT_DATE_INVALID', 'ERR_CERT_COMMON_NAME_INVALID',
        'ERR_SSL_PROTOCOL_ERROR', 'ERR_ACCESS_DENIED', 'ERR_BLOCKED_BY_CLIENT', 'ERR_FAILED', 'ERR_ABORTED',
        'ERR_HTTP2_PROTOCOL_ERROR', 'ERR_HTTP2_PING_FAILED', 'ERR_HTTP2_SERVER_REFUSED_STREAM', 'ERR_QUIC_PROTOCOL_ERROR',
        'ERR_NETWORK_IO_SUSPENDED', 'ERR_CONTENT_DECODING_FAILED', 'unknown'],
    phase: ['before_headers', 'body_read', 'post_read_binding'],
} as const;
export interface PlanNetworkDiagnostic {
    errorName?: typeof NETWORK_DIAGNOSTIC_VALUES.errorName[number];
    code?: typeof NETWORK_DIAGNOSTIC_VALUES.code[number];
    causeCode?: typeof NETWORK_DIAGNOSTIC_VALUES.code[number];
    chromiumCode?: typeof NETWORK_DIAGNOSTIC_VALUES.chromiumCode[number];
    phase?: typeof NETWORK_DIAGNOSTIC_VALUES.phase[number];
    elapsedMs?: number;
    requestBodyBytes?: number;
}
/** Inspect only named fields, never stringify an Error or walk a cause chain. */
function networkField(value: unknown, key: string, unavailable: unknown = undefined): unknown {
    try {
        return value && typeof value === 'object' && !Array.isArray(value) ? Reflect.get(value, key) : undefined;
    } catch (error: unknown) {
        // A hostile getter/proxy must not replace the original transport failure.
        console.warn('[chatgpt-plan] network_diagnostic_unavailable');
        return unavailable;
    }
}
/** Used again at both console and disk boundaries; all strings are fixed enums. */
export function safePlanNetworkDiagnostic(value: unknown): PlanNetworkDiagnostic {
    const result: Record<string, string | number> = {};
    for (const key of ['errorName', 'code', 'causeCode', 'chromiumCode', 'phase'] as const) {
        const item = networkField(value, key);
        const allowed = NETWORK_DIAGNOSTIC_VALUES[key === 'causeCode' ? 'code' : key];
        if (typeof item === 'string' && (allowed as readonly string[]).includes(item)) result[key] = item;
    }
    for (const [key, maximum] of [['elapsedMs', 24 * 60 * 60 * 1000], ['requestBodyBytes', 512000]] as const) {
        const item = networkField(value, key);
        if (typeof item === 'number' && Number.isInteger(item) && item >= 0 && item <= maximum) result[key] = item;
    }
    return result as PlanNetworkDiagnostic;
}
export function planNetworkFailureDiagnostic(error: unknown, elapsedMs: number, requestBodyBytes: number): PlanNetworkDiagnostic {
    return safePlanNetworkDiagnostic({ errorName: networkField(error, 'name'), code: networkField(error, 'code'),
        causeCode: networkField(networkField(error, 'cause'), 'code'), phase: 'before_headers', elapsedMs, requestBodyBytes });
}
/** Chromium puts its fixed net code in Error.message. Inspect only a bounded,
 * anchored prefix; never retain the message, URL, arbitrary code, or cause body. */
export function planPeerNetworkFailureDiagnostic(error: unknown, phase: PlanNetworkDiagnostic['phase']): PlanNetworkDiagnostic {
    const message = networkField(error, 'message');
    const primaryCode = networkField(error, 'code', 'unknown');
    // Preserve presence without retaining an arbitrary primary code: an unknown
    // or forbidden primary failure must not borrow a retryable nested cause.
    const code = primaryCode === undefined ? undefined : NETWORK_DIAGNOSTIC_VALUES.code.find(allowed => allowed === primaryCode) ?? 'unknown';
    const candidate = typeof message === 'string' ? /^net::(ERR_[A-Z0-9_]{1,64})(?:\s|$)/.exec(message.slice(0, 96))?.[1] : undefined;
    const chromiumCode = NETWORK_DIAGNOSTIC_VALUES.chromiumCode.find(code => code === candidate) ?? 'unknown';
    return safePlanNetworkDiagnostic({ errorName: networkField(error, 'name'), code,
        causeCode: networkField(networkField(error, 'cause'), 'code'),
        ...(typeof message === 'string' && message.startsWith('net::') ? { chromiumCode } : {}), phase });
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
    'peer changed': 'stale_source',
} as const;
function localFailureCategory(error: unknown): string {
    return error instanceof Error && Object.hasOwn(LOCAL_FAILURE_CATEGORIES, error.message)
        ? LOCAL_FAILURE_CATEGORIES[error.message as keyof typeof LOCAL_FAILURE_CATEGORIES] : 'local_failure';
}
/** Only fixed stages/categories/statuses reach trusted diagnostics, never provider text. */
export class PlanFailure extends Error {
    constructor(readonly stage: string, readonly category: string, readonly httpStatus?: number, readonly responseDiagnostic?: PlanResponseDiagnostic,
        readonly networkDiagnostic?: PlanNetworkDiagnostic) {
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
    const network = failure?.networkDiagnostic ? safePlanNetworkDiagnostic(failure.networkDiagnostic) : null;
    const correlation = safeFailureCorrelation(context);
    console.warn(`[chatgpt-plan] ${failure?.stage ?? stage}: ${category}${failure?.httpStatus !== undefined ? ` (http ${failure.httpStatus})` : ''}${diagnostic ? ` ${JSON.stringify(diagnostic)}` : ''}${network ? ` ${JSON.stringify({ networkDiagnostic: network })}` : ''}${correlation ? ` ${JSON.stringify({ correlation })}` : ''}`);
    if (failureSink) {
        const row = safePlanFailureRecord({ observedAt: new Date().toISOString(), stage: failure?.stage ?? stage,
            category, httpStatus: failure?.httpStatus, correlation: context, networkDiagnostic: network, responseDiagnostic: diagnostic });
        if (row) {
            try { failureSink(row); }
            catch (error: unknown) { console.warn('[chatgpt-plan] diagnostic_record_failed'); }
        }
    }
}


const PERSISTED_STAGES = new Set([
    'responses', 'catalog', 'peer_challenge', 'peer_rebind-challenge', 'peer_connect', 'peer_capabilities', 'peer_poll', 'peer_reply',
    'peer_disconnect', 'peer_rebind', 'peer_response_cleanup', 'peer_reply_cleanup', 'response_stream_cleanup',
    'source_refresh', 'source_restore', 'oauth_completion', 'oauth_revoke', 'oauth_error_body',
    'oauth_error_body_cleanup', 'oauth_identity', 'oauth_token', 'oauth_jwks', 'oauth_discovery', 'other',
]); // Fixed enum, never populated from errors.
const PERSISTED_CATEGORIES = new Set([
    ...Object.values(LOCAL_FAILURE_CATEGORIES), 'local_failure', 'cancelled', 'timeout', 'transport_error',
    'network_error', 'invalid_schema', 'invalid_signed_identity', 'stale_source', 'background_denied',
    'http_error', 'invalid_catalog', 'plan_scope_missing', 'credential_rejected', 'invalid_json',
    'incomplete_stream', 'invalid_stream', 'response_too_large', 'invalid_content_type',
]); // Fixed enum, never populated from errors.
export interface PlanFailureRecord {
    observedAt: string;
    stage: string;
    category: string;
    httpStatus?: number;
    networkDiagnostic?: PlanNetworkDiagnostic;
    responseDiagnostic?: PlanResponseDiagnostic;
    correlation?: Partial<Record<'requestId' | 'runId' | 'computerId', string>>;
}
/** Disk records have a smaller contract than console diagnostics. No arbitrary strings. */
export function safePlanFailureRecord(value: unknown): PlanFailureRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const input = value as Record<string, unknown>;
    if (typeof input.observedAt !== 'string' || input.observedAt.length !== 24
        || !Number.isFinite(Date.parse(input.observedAt)) || new Date(input.observedAt).toISOString() !== input.observedAt) return null;
    const row: PlanFailureRecord = { observedAt: input.observedAt,
        stage: typeof input.stage === 'string' && PERSISTED_STAGES.has(input.stage) ? input.stage : 'other',
        category: typeof input.category === 'string' && PERSISTED_CATEGORIES.has(input.category) ? input.category : 'local_failure' };
    if (typeof input.httpStatus === 'number' && Number.isInteger(input.httpStatus) && input.httpStatus >= 100 && input.httpStatus <= 599) row.httpStatus = input.httpStatus;
    const response = safePlanResponseDiagnostic(input.responseDiagnostic);
    if (Object.keys(response).length) row.responseDiagnostic = response;
    const network = safePlanNetworkDiagnostic(input.networkDiagnostic);
    if (Object.keys(network).length) row.networkDiagnostic = network;
    const correlation = safeFailureCorrelation(input.correlation);
    if (correlation) {
        const ids: NonNullable<PlanFailureRecord['correlation']> = {};
        for (const key of ['requestId', 'runId', 'computerId'] as const) if (correlation[key]) ids[key] = correlation[key];
        if (Object.keys(ids).length) row.correlation = ids;
    }
    return row;
}
let failureSink: ((record: PlanFailureRecord) => void) | undefined;
/** One explicit main-process owner; no global console interception or renderer IPC. */
export function observePlanFailures(sink: (record: PlanFailureRecord) => void): () => void {
    if (failureSink) throw new Error('Plan diagnostic owner already installed');
    failureSink = sink;
    return () => { if (failureSink === sink) failureSink = undefined; };
}
