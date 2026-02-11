import { ensureHome } from "@matrix-os/kernel";
import { createGateway } from "./server.js";

const homePath = ensureHome(process.env.MATRIX_HOME);
const port = Number(process.env.PORT ?? 4000);

const gateway = createGateway({ homePath, port });

console.log(`Matrix OS gateway running on http://localhost:${port}`);
console.log(`Home directory: ${homePath}`);

process.on("SIGINT", async () => {
  await gateway.close();
  process.exit(0);
});
