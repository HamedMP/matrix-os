/** Boots the real Matrix gateway; the Worker never substitutes a fake agent. */
import { ensureHome } from '@matrix-os/kernel';
import { createGateway } from '../../gateway/src/server.js';
import { prepareWorkspaceGatewayCredentials } from './gateway-credentials.js';

const homePath = ensureHome(process.env.MATRIX_HOME || '/workspace/home').homePath;
const credentials = await prepareWorkspaceGatewayCredentials(homePath);
let gateway: Awaited<ReturnType<typeof createGateway>>;
try {
  gateway = await createGateway({homePath, port:4000, model:credentials.model, maxTurns:8,
    ...(credentials.kernelCredentialResolver ? {kernelCredentialResolver:credentials.kernelCredentialResolver} : {})});
} catch (error:unknown) {
  await credentials.close(); throw error;
}
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  try { await gateway.close(); }
  finally { await credentials.close(); }
  process.exit(0);
};
process.on('SIGTERM', () => { void close(); });
process.on('SIGINT', () => { void close(); });
