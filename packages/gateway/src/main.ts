import { ensureHome, loadHandle } from "@matrix-os/kernel";
import { createGateway } from "./server.js";

const homePath = ensureHome(process.env.MATRIX_HOME);
const port = Number(process.env.PORT ?? 4000);

const gateway = createGateway({ homePath, port });

console.log(`Matrix OS gateway running on http://localhost:${port}`);
console.log(`Home directory: ${homePath}`);

const proxyUrl = process.env.PROXY_URL;
if (proxyUrl) {
  const identity = loadHandle(homePath);
  const handle = identity.handle || process.env.MATRIX_HANDLE || 'anonymous';
  const shellPort = Number(process.env.SHELL_PORT ?? 3000);
  const gatewayUrl = process.env.GATEWAY_EXTERNAL_URL ?? `http://${handle}:${port}`;
  fetch(`${proxyUrl}/instances/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle, gatewayUrl, shellPort }),
  }).then(() => console.log(`Registered with proxy as "${handle}"`))
    .catch((e) => console.warn(`Proxy registration failed: ${(e as Error).message}`));
}

process.on("SIGINT", async () => {
  await gateway.close();
  process.exit(0);
});
