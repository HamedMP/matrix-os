import { logPlanFailure, PlanFailure } from './diagnostics';

/** Only definitive fixed-origin credential rejection can start explicit reauthorization. */
export function rejectedPlanCredential(error: unknown): boolean {
    return error instanceof PlanFailure && (error.stage === 'catalog' && error.category === 'http_error' && error.httpStatus === 401
        || error.stage === 'oauth_token' && error.category === 'credential_rejected');
}

/** OAuth invalid_grant is a protocol code, never an arbitrary provider error message. */
export async function rejectedRefreshGrant(response: Response, parent?: AbortSignal): Promise<boolean> {
    if (!response.body) return false;
    const reader = response.body.getReader();
    const signal = parent ? AbortSignal.any([parent, AbortSignal.timeout(1000)]) : AbortSignal.timeout(1000);
    let interrupted!: () => void;
    const interruption = new Promise<never>((_, reject) => { interrupted = () => reject(signal.reason); });
    signal.addEventListener('abort', interrupted, { once: true });
    let text = '';
    let bytes = 0;
    const decoder = new TextDecoder();
    try {
        while (true) {
            signal.throwIfAborted();
            const chunk = await Promise.race([reader.read(), interruption]);
            signal.throwIfAborted();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > 4096) return false;
            text += decoder.decode(chunk.value, { stream: true });
        }
        const value: unknown = JSON.parse(text + decoder.decode());
        return !!value && typeof value === 'object' && 'error' in value && value.error === 'invalid_grant';
    } catch (error: unknown) {
        if (!signal.aborted && !(error instanceof SyntaxError)) logPlanFailure('oauth_error_body', error);
        return false;
    } finally {
        signal.removeEventListener('abort', interrupted);
        try { void reader.cancel().catch((error: unknown) => logPlanFailure('oauth_error_body_cleanup', error)); }
        catch (error: unknown) { logPlanFailure('oauth_error_body_cleanup', error); }
        finally { reader.releaseLock(); }
    }
}
