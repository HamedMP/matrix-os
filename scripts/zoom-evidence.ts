// Zoom feature evidence: launch the built app against the stub gateway,
// sign in, zoom to 150% via the appearance store IPC path, screenshot,
// reset to 100%, screenshot. Run: pnpm exec tsx scripts/zoom-evidence.ts
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright";
import { startStubGateway } from "../tests/e2e/desktop/fixtures/stub-gateway";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DESKTOP_MAIN = resolve(HERE, "../desktop/out/main/index.js");
const OUT = resolve(HERE, "../desktop/screenshots");
mkdirSync(OUT, { recursive: true });

const gateway = await startStubGateway();
const userDataDir = mkdtempSync(join(tmpdir(), "operator-zoom-"));
const app = await _electron.launch({
  args: [DESKTOP_MAIN],
  env: { ...process.env, OPERATOR_GATEWAY_URL: gateway.url, OPERATOR_USER_DATA_DIR: userDataDir },
});
const page = await app.firstWindow();
await page.getByRole("button", { name: /continue with github/i }).click();
await page.locator("aside button", { hasText: "Terminal" }).first().waitFor({ timeout: 15_000 });

const factor = await page.evaluate(async () => {
  const op = (window as unknown as { operator: { invoke(c: string, p: unknown): Promise<unknown> } }).operator;
  await op.invoke("app:set-zoom", { factor: 1.5 });
  return op.invoke("app:get-zoom", {});
});
console.log("zoom after set 1.5:", JSON.stringify(factor));
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, "evidence-zoom-150.png") });

await page.evaluate(async () => {
  const op = (window as unknown as { operator: { invoke(c: string, p: unknown): Promise<unknown> } }).operator;
  await op.invoke("app:set-zoom", { factor: 1.0 });
});
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, "evidence-zoom-100.png") });

await app.close();
await gateway.close();
console.log("zoom evidence captured");
