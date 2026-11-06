import { app, session, type Session } from 'electron';

// One nonpersistent partition per app, isolated from renderer auth hooks/cookies.
let networkSession: Session | undefined;
/** Chromium owns system proxy resolution; do not configure proxy or retry here. */
export const fetchNativePlan: typeof fetch = async (input, init) => {
    const signal = init?.signal !== undefined ? init.signal : input instanceof Request ? input.signal : undefined;
    signal?.throwIfAborted();
    const requestInput = input instanceof URL ? input.toString() : input;
    let protocol: string;
    try { protocol = new URL(typeof requestInput === 'string' ? requestInput : requestInput.url).protocol; }
    catch (error: unknown) {
        if (error instanceof TypeError) throw new Error('Unsupported native plan transport URL');
        throw error;
    }
    if (protocol !== 'http:' && protocol !== 'https:') throw new Error('Unsupported native plan transport URL');
    let interrupted: (() => void) | undefined;
    try {
        const ready = app.whenReady();
        if (signal) {
            const stopped = new Promise<never>((_, reject) => {
                interrupted = () => reject(signal.reason);
                signal.addEventListener('abort', interrupted, { once: true });
                if (signal.aborted) interrupted();
            });
            await Promise.race([ready, stopped]);
        } else await ready;
        signal?.throwIfAborted();
    } finally {
        if (signal && interrupted) signal.removeEventListener('abort', interrupted);
    }
    networkSession ??= session.fromPartition('matrix-chatgpt-plan-network', { cache: false });
    // URL is outside Electron's fetch input union; Request must retain its body,
    // headers and signal instead of being rebuilt or converted to a URL string.
    return networkSession.fetch(requestInput, {
        ...init, credentials: 'omit', cache: 'no-store',
    });
};
