import { createHash, createPublicKey, generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import { expect, vi } from 'vitest';
import { exportJWK, SignJWT } from 'jose';
import { ChatGptPlanPeerConnectSchema, ChatGptPlanPeerPollV2RequestSchema, ChatGptPlanPeerReplySchema,
  chatGptPlanPeerProof, chatGptPlanPeerRequestId, type ChatGptPlanPeerRequest } from '@matrix-os/contracts';
import { createNativeChatgptPlanService } from '../../desktop/src/main/chatgpt-plan/service';
import { PlanFailure } from '../../desktop/src/main/chatgpt-plan/diagnostics';
import type { PlanVaultRecord } from '../../desktop/src/main/chatgpt-plan/vault';

export const session = { runtimeSlot: 'primary', authGeneration: 1 };
const accountId = '00000000-0000-4000-8000-000000000002';
const sessionId = '00000000-0000-4000-8000-000000000001';
export async function settle() { for (let i = 0; i < 100; i++) await Promise.resolve(); }
/** Only the clock and external transport are injected. No OAuth server or socket. */
export function catalogFixture(tokenLifetime = 3600000) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  // Node's native AbortSignal timer bypasses fake timers. Preserve its actual
  // controller/reason contract using the same test clock as peer/service timers.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Deadline', 'TimeoutError')), ms).unref();
    return controller.signal;
  });
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' });
  let stored: PlanVaultRecord = {
    version: 1, ownerId: 'owner', hostId: 'fixture-host', deviceId: createHash('sha256').update(publicKey).digest('hex'),
    devicePublicKey: publicKey.toString('base64url'), devicePrivateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    activeAccountId: accountId, accounts: [{ id: accountId, clientId: 'fixture-client', subject: 'fixture-subject', label: 'Fixture',
      tokens: { clientId: 'fixture-client', subject: 'fixture-subject', accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh',
        idToken: 'synthetic-id', scopes: [], expiresAt: Date.now() + tokenLifetime } }],
    grants: [{ computerId: 'computer', revision: 1, enabled: true, background: false }],
  };
  const authState = { ...session, signedIn: true as const, userId: 'owner', handle: 'computer', platformHost: 'https://matrix.test' };
  type Mode = 'ok' | 'timeout' | 'reset' | 'unknown' | 'tls' | 'auth' | 'schema' | 'fake-timeout'
    | 'reset-unknown-cause' | 'reset-nested-tls' | 'typed-reset';
  let mode: Mode = 'ok', model = 'fixture-visible', aborted = false, releaseResponse: (() => void) | undefined;
  let nextRead: { gate: Promise<void>; mode: Mode; model: string } | undefined;
  let issuer: { publicKey: KeyObject; privateKey: KeyObject } | undefined;
  let queued: ChatGptPlanPeerRequest[] = [], wake: (() => void) | undefined;
  const snapshots: Array<Record<string, unknown>> = [], bodies: unknown[] = [], replies: unknown[] = [];
  let disconnects = 0, reads = 0;
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    if (path === '/.well-known/jwks.json') {
      issuer ??= generateKeyPairSync('rsa', { modulusLength: 2048 });
      return Response.json({ keys: [{ ...await exportJWK(issuer.publicKey), kid: 'fixture', alg: 'RS256' }] });
    }
    if (path === '/api/accounts/oauth/token') {
      issuer ??= generateKeyPairSync('rsa', { modulusLength: 2048 });
      const scope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
      const sign = (claims: Record<string, unknown>, audience: string) => new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'fixture' })
        .setIssuer('https://auth.openai.com').setAudience(audience).setSubject('fixture-subject').setExpirationTime('1h').sign(issuer!.privateKey);
      return Response.json({ access_token: await sign({ client_id: 'fixture-client', scope }, 'https://api.openai.com/v1'),
        id_token: await sign({}, 'fixture-client'), refresh_token: 'rotated-synthetic', scope, token_type: 'Bearer', expires_in: 3600 });
    }
    if (path === '/v1/models') {
      reads++;
      const override = nextRead; nextRead = undefined;
      if (override) await override.gate;
      const readMode = override?.mode ?? mode;
      if (readMode === 'timeout') return new Promise((_, reject) => {
        if (init?.signal?.aborted) reject(init.signal.reason);
        else init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      });
      if (readMode === 'reset') throw Object.assign(new TypeError('synthetic transport'), { cause: { code: 'ECONNRESET' } });
      if (readMode === 'reset-unknown-cause') throw Object.assign(new TypeError('synthetic transport'), { code: 'ECONNRESET', cause: { code: 'UNCLASSIFIED_POLICY' } });
      if (readMode === 'reset-nested-tls') throw Object.assign(new TypeError('synthetic transport'), { cause: { code: 'ECONNRESET', cause: { code: 'CERT_HAS_EXPIRED' } } });
      if (readMode === 'typed-reset') throw Object.assign(new PlanFailure('catalog', 'network_error'), { cause: { code: 'ECONNRESET' } });
      if (readMode === 'unknown') throw new Error('unclassified sentinel');
      if (readMode === 'tls') throw Object.assign(new TypeError('synthetic TLS'), { cause: { code: 'CERT_HAS_EXPIRED' } });
      if (readMode === 'fake-timeout') throw new DOMException('not an owned deadline', 'TimeoutError');
      if (readMode === 'auth') return Response.json({}, { status: 401 });
      if (readMode === 'schema') return Response.json({ models: [{ slug: '' }] });
      return Response.json({ models: [{ slug: override?.model ?? model, display_name: 'Fixture', visibility: 'list' }] });
    }
    if (path === '/v1/responses') {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"pending"}\n\n'));
          releaseResponse = () => { if (!aborted) {
            controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed","response":{"status":"completed","model":"fixture-visible"}}\n\n'));
            controller.close();
          } };
        }, cancel() { aborted = true; },
      }), { headers: { 'content-type': 'text/event-stream' } });
    }
    if (path.endsWith('/challenge')) return Response.json({ version: 1, challenge: 'a'.repeat(64), ownerId: authState.userId,
      computerId: authState.handle, expiresAt: new Date(Date.now() + 60000).toISOString() });
    if (path.endsWith('/connect')) {
      const body = ChatGptPlanPeerConnectSchema.parse(JSON.parse(String(init?.body))); snapshots.push(body.snapshot);
      const proof = chatGptPlanPeerProof({ challenge: body.challenge, ownerId: authState.userId, computerId: authState.handle, snapshot: body.snapshot });
      expect(verify(null, Buffer.from(proof), createPublicKey({ key: Buffer.from(body.publicKey, 'base64url'), type: 'spki', format: 'der' }), Buffer.from(body.signature, 'base64url'))).toBe(true);
      expect(JSON.stringify(body)).not.toContain('synthetic-access');
      return Response.json({ version: 1, sessionId });
    }
    if (path.endsWith('/capabilities')) return Response.json({ version: 1, sessionId, pollDeliveryVersion: 2 });
    if (path.endsWith('/poll-v2')) {
      const receipt = ChatGptPlanPeerPollV2RequestSchema.parse(JSON.parse(String(init?.body)));
      if (!queued.length) await new Promise<void>((resolve, reject) => {
        const finish = () => { clearTimeout(timer); init?.signal?.removeEventListener('abort', abort); wake = undefined; resolve(); };
        const abort = () => { clearTimeout(timer); wake = undefined; reject(init?.signal?.reason); };
        const timer = setTimeout(finish, 10000); wake = finish;
        init?.signal?.addEventListener('abort', abort, { once: true });
      });
      const items = queued; queued = [];
      return Response.json({ version: 2, sessionId, acknowledgedThrough: receipt.ackThrough,
        deliveries: items.map((request, i) => ({ deliverySequence: receipt.ackThrough + i + 1, request })) });
    }
    if (path.endsWith('/reply')) { replies.push(ChatGptPlanPeerReplySchema.parse(JSON.parse(String(init?.body)))); return Response.json({ version: 1, ok: true }); }
    if (path.endsWith('/disconnect')) { disconnects++; return Response.json({ ok: true }); }
    if (path === '/.well-known/openid-configuration') return Response.json({ revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke' });
    if (path.endsWith('/revoke')) return new Response(null, { status: 200 });
    throw new Error('unexpected synthetic transport endpoint');
  });
  const service = createNativeChatgptPlanService({
    auth: { getStatus: () => authState, getToken: () => 'synthetic-matrix', getGatewayOrigin: () => 'https://matrix.test' },
    vault: { load: async () => structuredClone(stored), save: async (_, next) => { stored = structuredClone(next); }, cleanup: async () => {} },
    openBrowser: async () => { throw new Error('OAuth forbidden in catalog tests'); }, fetchFn,
  });
  return { service, authState, snapshots, bodies, replies, fetchFn,
    mode: (value: Mode) => { mode = value; }, changeModel: () => { model = 'fixture-new'; },
    holdOneCatalog(readMode: Mode) {
      let release!: () => void;
      nextRead = { gate: new Promise<void>(resolve => { release = resolve; }), mode: readMode, model };
      return release;
    },
    get aborted() { return aborted; }, get disconnects() { return disconnects; }, get reads() { return reads; },
    async start() { const status = await service.status(session); expect(status.bridgeConnected).toBe(true); expect(status.grant.background).toBe(false); return status; },
    async infer(expected = 1) {
      queued.push({ version: 1, action: 'infer', id: chatGptPlanPeerRequestId(sessionId, 1), sequence: 1,
        expiresAt: new Date(Date.now() + 120000).toISOString(), accountId, grantRevision: 1, computerId: 'computer', runId: 'run_fixture',
        requestClass: 'interactive', model: 'fixture-visible', body: JSON.stringify({ model: 'fixture-visible', input: [{ role: 'user', content: 'fixture' }], store: false, stream: true }) });
      wake?.(); await settle();
      if (bodies.length !== expected) await vi.waitFor(() => expect(bodies).toHaveLength(expected), { timeout: 1000, interval: 10 });
      expect(bodies).toHaveLength(expected);
    },
    release() { releaseResponse?.(); },
    async cleanup() {
      const disposing = service.dispose();
      await vi.advanceTimersByTimeAsync(15000); await disposing;
      vi.restoreAllMocks(); vi.useRealTimers();
    },
  };
}
