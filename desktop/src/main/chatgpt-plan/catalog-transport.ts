import { PlanFailure, planPeerNetworkFailureDiagnostic } from './diagnostics';

const TRANSIENT_NODE = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH']);
const TRANSIENT_CHROME = new Set(['ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_TIMED_OUT', 'ERR_NAME_NOT_RESOLVED',
    'ERR_ADDRESS_UNREACHABLE', 'ERR_CONNECTION_RESET', 'ERR_CONNECTION_CLOSED', 'ERR_CONNECTION_ABORTED',
    'ERR_NETWORK_CHANGED', 'ERR_TIMED_OUT', 'ERR_INTERNET_DISCONNECTED', 'ERR_EMPTY_RESPONSE']);
/** Diagnostic projection drops unknown nested codes. Check the bounded original
 * chain first so a reset cannot lend authority to an unclassified/security cause. */
function knownTransportCauses(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    try {
        let value: unknown = error;
        for (let depth = 0; value !== undefined && depth < 4; depth++) {
            if (!value || typeof value !== 'object' || Array.isArray(value)
                || value instanceof PlanFailure || value instanceof DOMException || value instanceof AggregateError
                || Reflect.get(value, 'name') === 'TimeoutError') return false;
            const code: unknown = Reflect.get(value, 'code');
            if ((depth > 0 || code !== undefined) && (typeof code !== 'string' || !TRANSIENT_NODE.has(code))) return false;
            value = Reflect.get(value, 'cause');
        }
        return value === undefined;
    } catch (error: unknown) {
        console.warn('[chatgpt-plan] catalog transport classification unavailable');
        return false;
    }
}
/** Classify only the models fetch boundary before planJson coarsens its error.
 * Unknown, TLS/policy errors and arbitrary TimeoutError objects fail closed. */
export function catalogTransport(fetchFn: typeof fetch, caller: AbortSignal) {
    let transient = false;
    const fetchCatalog: typeof fetch = async (input, init) => {
        try { return await fetchFn(input, init); }
        catch (error: unknown) {
            if (!caller.aborted) {
                const signal = init?.signal;
                if (signal?.aborted) transient = error === signal.reason && error instanceof DOMException && error.name === 'TimeoutError';
                else if (knownTransportCauses(error)) {
                    const { code, causeCode, chromiumCode } = planPeerNetworkFailureDiagnostic(error, 'before_headers');
                    const codes = [code, causeCode].filter((value): value is NonNullable<typeof code> => value !== undefined);
                    transient = codes.every(value => TRANSIENT_NODE.has(value))
                        && (chromiumCode === undefined || TRANSIENT_CHROME.has(chromiumCode))
                        && (codes.length > 0 || chromiumCode !== undefined);
                }
            }
            throw error;
        }
    };
    return { fetchCatalog, transient: () => transient && !caller.aborted };
}
