/** Built Electron UI review with synthetic, owner-isolated child activity. Ctrl-C cleans up. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { _electron } from "playwright";
import { startSubagentGateway } from "../../tests/e2e/desktop/fixtures/subagent-gateway";
import { closeElectronApp } from "../../tests/e2e/desktop/fixtures/close-electron";

const root = resolve(import.meta.dirname, "../..");
const profile = await mkdtemp("/tmp/om283-human-review-");
const gateway = await startSubagentGateway();
const launch = () => _electron.launch({
  executablePath: createRequire(join(root, "desktop/package.json"))("electron") as string,
  args: [join(root, "tests/e2e/desktop/fixtures/canonical-input-electron.mjs")],
  env: { ...process.env, OPERATOR_USER_DATA_DIR: profile, OPERATOR_GATEWAY_URL: gateway.url },
});
let app = await launch();
try {
  const encrypted = await app.evaluate(async ({ app, safeStorage }) => {
    await app.whenReady();
    return safeStorage.encryptString(JSON.stringify({ accessToken: "stub-token-1", expiresAt: Date.now() + 3_600_000, userId: "user-1", handle: "neo" })).toString("base64");
  });
  await writeFile(join(profile, "credential.bin"), Buffer.from(encrypted, "base64"));
  await closeElectronApp(app);
  app = await launch();
  process.stdout.write("OM-283 UI review: open Chat → Subagent activity review → Worked for. Synthetic data; no production connection. Ctrl-C cleans up.\n");
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve); process.once("SIGTERM", resolve);
    app.once("close", resolve);
  });
} finally {
  await closeElectronApp(app);
  await gateway.close();
  await rm(profile, { recursive: true, force: true });
}
