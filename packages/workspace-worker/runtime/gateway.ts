/** Boots the real Matrix gateway; the Worker never substitutes a fake agent. */
import { ensureHome } from '@matrix-os/kernel';
import { createGateway } from '../../gateway/src/server.js';
import { createOwnerAnthropicKeySaver } from '../../gateway/src/ai-providers/owner-anthropic-key.js';

const homePath = ensureHome(process.env.MATRIX_HOME || '/workspace/home').homePath;
// The actual gateway deliberately rejects ambient API keys. Populate its canonical
// owner credential only inside this isolated runtime; backups exclude this file.
if (!process.env.ANTHROPIC_API_KEY) throw new Error('Runtime credential missing');
const credential = createOwnerAnthropicKeySaver({homePath});
await credential(process.env.ANTHROPIC_API_KEY);
const gateway = await createGateway({
  homePath, port: 4000, model: 'claude-haiku-4-5', maxTurns: 8,
});
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await gateway.close();
  await credential.revoke();
  process.exit(0);
};
process.on('SIGTERM', () => { void close(); });
process.on('SIGINT', () => { void close(); });
