import { createServer } from 'node:http';
import { logPlanFailure } from './diagnostics';
import { randomBytes } from 'node:crypto';
import { planAuthorizationUrl, parsePlanCallback } from './oauth';
export async function startPlanLoopback(input: {
    hostId: string;
    clientId?: string;
    idToken?: string;
    signal: AbortSignal;
    openBrowser(url: string): Promise<void>;
    complete(value: {
        code: string;
        clientId: string;
        verifier: string;
        nonce: string;
        redirectUri: string;
    }): Promise<void>;
    failed(): void;
}) {
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    let consumed = false;
    let redirectUri = '';
    let completion: Promise<void> | null = null;
    const server = createServer({ maxHeaderSize: 16384 }, (request, response) => {
        const reject = () => {
            response.writeHead(400, {
                'content-type': 'text/plain', 'cache-control': 'no-store'
            });
            response.end('Sign-in could not be completed. Return to Matrix OS.');
        };
        if (input.signal.aborted || consumed || request.method !== 'GET' || request.headers.host !== new URL(redirectUri).host || request.headers.origin) {
            reject();
            return;
        }
        let callback;
        try {
            callback = parsePlanCallback(request.url ?? '', {
                state, clientId: input.clientId
            });
        }
        catch (error: unknown) {
            reject();
            if (error instanceof Error && error.message === 'authorization denied') {
                consumed = true;
                void close();
                input.failed();
            }
            return;
        }
        consumed = true;
        response.writeHead(200, {
            'content-type': 'text/plain', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'"
        });
        response.end('Return to Matrix OS to check your connection.');
        void close();
        completion = input.complete({
            ...callback, verifier, nonce, redirectUri
        }).catch((error: unknown) => { logPlanFailure('oauth_completion', error); input.failed(); });
    });
    server.requestTimeout = 5000;
    server.headersTimeout = 5000;
    server.maxConnections = 4;
    let closed: Promise<void> | null = null;
    const close = () => closed ??= new Promise<void>(resolve => { input.signal.removeEventListener('abort', aborted); clearTimeout(timeout); server.close(() => resolve()); server.closeAllConnections(); });
    const aborted = () => { void close(); };
    const timeout = setTimeout(() => { input.failed(); void close(); }, 5 * 60 * 1000);
    timeout.unref();
    try {
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
    }
    catch (error: unknown) {
        await close();
        throw error;
    }
    const address = server.address();
    if (!address || typeof address === 'string')
        throw new Error('callback unavailable');
    redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
    input.signal.addEventListener('abort', aborted, { once: true });
    if (input.signal.aborted) {
        await close();
        throw new Error('authorization cancelled');
    }
    try {
        await input.openBrowser(planAuthorizationUrl({
            hostId: input.hostId, clientId: input.clientId, idToken: input.idToken, redirectUri, state, nonce, verifier
        }));
    }
    catch (error: unknown) {
        await close();
        throw error;
    }
    return {
        close, async drain() { await completion; }
    };
}
