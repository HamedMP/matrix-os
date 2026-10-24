import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { Hono } from 'hono';
import { chatGptPlanPeerProof } from '@matrix-os/contracts';
import { markVerifiedRuntimeBearer } from '../../../packages/gateway/src/request-principal.js';
import { createChatGptPlanPeerRoutes } from '../../../packages/gateway/src/bots/chatgpt-plan-peer-routes.js';
import { createChatGptPlanPeers } from '../../../packages/gateway/src/bots/chatgpt-plan-peers.js';
import { createBotStateDatabase } from './bot-state-support.js';

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
export const peerRoot = '/api/chatgpt-plan/device';
export const postBody = (body: unknown, bearer = true): RequestInit => ({ method: 'POST',
  headers: { 'content-type': 'application/json', ...(bearer ? { authorization: 'Bearer fixture' } : {}) }, body: JSON.stringify(body) });
export async function deliveryFixture(now?: () => number) {
  const database = await createBotStateDatabase();
  const peers = createChatGptPlanPeers({ db: database.db, ownerId: 'owner', computerId: 'computer', now });
  const snapshot = { deviceId: createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('hex'),
    accountId: 'account_own', grantRevision: 3, enabled: true, background: false,
    models: [{ id: 'gpt-server', displayName: 'Fixture', input: ['text' as const], contextWindow: 128000, maxOutputTokens: 8192 }] };
  async function connect() {
    const challenge = peers.challenge('owner');
    return peers.connect('owner', { version: 1, challenge: challenge.challenge, publicKey, snapshot,
      signature: sign(null, Buffer.from(chatGptPlanPeerProof({ ...challenge, snapshot })), keys.privateKey).toString('base64url') });
  }
  const session = await connect();
  const app = (owner = 'owner', source = 'jwt', verified = true) => {
    const router = new Hono();
    router.use('*', async (c, next) => { if (verified) markVerifiedRuntimeBearer(c); await next(); });
    router.route('/', createChatGptPlanPeerRoutes({ peers, getPrincipal: () => ({ userId: owner, source }) as never }));
    return router;
  };
  const binding = async () => ({ ownerId: 'owner', runId: 'run_fixture', requestClass: 'interactive',
    ...await peers.resolve({ instanceId: 'matrix_chatgpt_plan', model: 'gpt-server', options: [
      { id: 'accountId', value: 'account_own' }, { id: 'grantRevision', value: '3' },
    ] }, 'owner', 'interactive') } as never);
  return { peers, session, app, connect, binding, snapshot,
    nativeBinding: { runtimeSlot: 'primary', authGeneration: 1, ownerId: 'owner', computerId: 'computer',
      origin: 'https://fixture.invalid', bearer: 'fixture', publicKey,
      privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
    async close() { peers.close(); await database.destroy(); },
  };
}
