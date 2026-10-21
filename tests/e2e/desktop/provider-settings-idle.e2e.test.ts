import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { ProviderSettingsSnapshotSchema, type ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { providerAuthSettingsSnapshot, startProviderAuthGateway } from "./fixtures/provider-auth-gateway";
import { createEvidenceDirectory } from "./fixtures/evidence-directory";
import { dismissGettingStartedOnInteraction } from "./fixtures/getting-started";

const root = resolve(__dirname, "../../..");
const built = existsSync(join(root, "desktop/out/main/index.js"));
if (process.env.MATRIX_DESKTOP_E2E_REQUIRED === "1" && !built) throw new Error("Required Electron Desktop build is missing");
const suite = built ? describe : describe.skip;
const executablePath = createRequire(join(root, "desktop/package.json"))("electron") as string;

/** A real five-second evidence TTL; never claims real authentication or readiness. */
function snapshot(): ProviderSettingsSnapshot {
  const base = providerAuthSettingsSnapshot(true, true);
  const observedAt = Date.now();
  const checkedAt = new Date(observedAt).toISOString();
  const observation = { state: "present_unverified", checkedAt, staleAfter: new Date(observedAt + 5000).toISOString() };
  return ProviderSettingsSnapshotSchema.parse({ ...base, refreshedAt: checkedAt,
    modelProviders: [...base.modelProviders, { id: "openai-codex", displayName: "OpenAI Codex", models: [{ id: "openai-codex:gpt-5.6-sol", displayName: "GPT-5.6", enabled: true }] }],
    accessSources: [...base.accessSources, { id: "hermes_native", kind: "harness_profile", harness: "hermes", providerId: "openai-codex", fundingKind: "owner_account", accountId: null,
      displayName: "Hermes account", eligibleModelIds: ["openai-codex:gpt-5.6-sol"], localObservation: observation,
      readiness: { state: "unknown", checkedAt: null, staleAfter: null, safeReason: "unknown", action: "retry" },
      usage: { kind: "unavailable", authority: "unavailable", state: "not_applicable", scope: "access_source", reason: "provider_does_not_report", asOf: checkedAt } }],
    harnesses: [...base.harnesses, { ...base.harnesses[0]!, id: "hermes_native", harness: "hermes", displayName: "Hermes", enabled: true, configuredEnabled: true,
      installState: "installed", authState: "unknown", accountIds: [], selectedAccountId: null, accessSourceId: "hermes_native", localObservation: observation,
      route: { kind: "configurable", providerId: "openai-codex", modelId: "openai-codex:gpt-5.6-sol" } }],
  });
}

suite("Electron Desktop idle provider Settings (synthetic gateway)", () => {
  let app: ElectronApplication;
  let page: Page;
  let gateway: Awaited<ReturnType<typeof startProviderAuthGateway>>;
  let profile: string;
  let captures: ReturnType<typeof createEvidenceDirectory>;
  let reads = 0;
  let capabilityReads = 0;
  let mutations = 0;
  const settings = () => page.locator(".matrix-agents-providers");
  const refresh = () => settings().getByRole("button", { name: "Refresh provider status", exact: true });
  const hermes = () => settings().locator(".matrix-ap-rail-item").filter({ hasText: "Hermes" }).first();

  beforeAll(async () => {
    captures = createEvidenceDirectory(process.env.MATRIX_SETTINGS_EVIDENCE_DIR);
    gateway = await startProviderAuthGateway({ inlineClaude: true, settings: snapshot });
    profile = mkdtempSync(join(tmpdir(), "matrix-provider-settings-idle-"));
    app = await _electron.launch({ executablePath, args: [join(root, "desktop/out/main/index.js")],
      env: { ...process.env, OPERATOR_GATEWAY_URL: gateway.url, OPERATOR_USER_DATA_DIR: profile } });
    await app.evaluate(({ shell }) => { shell.openExternal = async () => {}; });
    page = await app.firstWindow();
    await dismissGettingStartedOnInteraction(page);
    page.on("request", request => {
      const path = new URL(request.url()).pathname;
      if (path === "/api/ai/provider-settings" && request.method() === "GET") reads++;
      if (path.startsWith("/api/ai/provider-settings/workflows/") && path.endsWith("/capabilities")) capabilityReads++;
      if (path.startsWith("/api/ai/provider-settings") && request.method() !== "GET") mutations++;
    });
    await page.getByRole("button", { name: /create account/i }).waitFor();
    await page.evaluate(() => window.operator.invoke("auth:start-device-flow", {}));
    await page.getByRole("button", { name: "Terminal", exact: true }).first().waitFor({ timeout: 15_000 });

    await page.getByRole("button", { name: "Open account menu", exact: true }).click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Agents & providers", exact: true }).click();
    await refresh().waitFor({ timeout: 15_000 });
    await page.waitForFunction(() => {
      const button = document.querySelector<HTMLButtonElement>('.matrix-agents-providers button[aria-label="Refresh provider status"]');
      return button !== null && !button.disabled;
    });
    await hermes().click();
    await settings().locator('.matrix-ap-rail-item[aria-expanded="true"]').filter({ hasText: "Hermes" }).first().waitFor();
  }, 60_000);

  afterAll(async () => {
    try { await app?.close(); }
    finally {
      try { await gateway?.close(); }
      finally { if (profile) rmSync(profile, { recursive: true, force: true }); captures?.cleanup(); }
    }
  });

  it("retains an expanded provider and usable controls without TTL-driven snapshot/capability reads", async () => {
    expect(await app.evaluate(({ app }) => app.getAppPath())).toBe(join(root, "desktop/out/main"));
    // Settle initial workflow negotiation, then observe beyond two full TTLs.
    await page.waitForTimeout(500);
    const baseline = { reads, capabilityReads };
    await page.waitForTimeout(12_000);
    await page.screenshot({ path: join(captures.path, "idle-hermes-expired.png") });
    expect(reads - baseline.reads).toBe(0);
    expect(capabilityReads - baseline.capabilityReads).toBe(0);
    expect(await refresh().isEnabled()).toBe(true);
    expect(await settings().getAttribute("aria-busy")).not.toBe("true");
    expect(await hermes().getAttribute("aria-expanded")).toBe("true");
    // Expiry is still truthful and does not remove the saved native connection.
    expect(await hermes().innerText()).toContain("Checking connection");
    expect(mutations).toBe(0);
  }, 20_000);

  it("manual Refresh performs one new read and retains expansion without rearming polling", async () => {
    await expect.poll(() => refresh().isEnabled()).toBe(true);
    const baseline = reads;
    await refresh().click();
    await expect.poll(() => reads).toBe(baseline + 1);
    await expect.poll(() => refresh().isEnabled()).toBe(true);
    expect(await hermes().getAttribute("aria-expanded")).toBe("true");
    await page.waitForTimeout(6000);
    expect(reads).toBe(baseline + 1);
    expect(mutations).toBe(0);
    expect(gateway.workflowEvents).toEqual([]);
    await page.screenshot({ path: join(captures.path, "explicit-refresh-expired.png") });
  }, 15_000);
});
