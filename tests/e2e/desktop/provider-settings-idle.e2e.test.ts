import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { ProviderSettingsSnapshotSchema, type ProviderManagedCreditObservation, type ProviderSettingsSnapshot } from "@matrix-os/contracts";
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
      if (path.startsWith("/api/ai/provider-settings") && !["GET", "OPTIONS"].includes(request.method())) mutations++;
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

const model = "anthropic/claude-opus-5";

function credit(remaining = 5_000_000): ProviderManagedCreditObservation {
  const asOf = new Date().toISOString();
  return { contractVersion: 1, revision: 2, gatewayPolicyAccessSourceId: "matrix_included", topUpEnabled: false,
    policy: { enabled: true, globalRevision: 1, runtimeRevision: 1, allowedModelIds: [model], monthlyBudgetMicrousd: 5_000_000,
      checkedAt: asOf, staleAfter: new Date(Date.now() + 60_000).toISOString() },
    usage: { kind: "managed_credit", authority: "matrix_ledger", state: "current", scope: "owner_entitlement", currency: "USD",
      usedMicrousd: 5_000_000 - remaining, remainingMicrousd: remaining, limitMicrousd: 5_000_000,
      periodStartedAt: asOf, resetsAt: null, asOf,
      chatAvailability: { contractVersion: 1, asOf, eligibleBalanceMicrousd: remaining, availableBalanceMicrousd: remaining },
      credit: { promotionalBalanceMicrousd: remaining, addonBalanceMicrousd: 0, creditBalanceMicrousd: remaining,
        reservedMicrousd: 0, remainingBalanceMicrousd: remaining },
      budget: { monthlyBudgetMicrousd: 5_000_000, settledThisMonthMicrousd: 5_000_000 - remaining,
        reservedThisMonthMicrousd: 0, remainingBudgetMicrousd: remaining } } };
}

/** A deliberately historical Gateway DTO; never claims a real provider login. */
function signupSnapshot(authenticated: boolean) {
  const base = providerAuthSettingsSnapshot(authenticated, true);
  return ProviderSettingsSnapshotSchema.parse({ ...base,
    accessSources: [...base.accessSources, { id: "matrix_included", kind: "matrix_gateway", fundingKind: "matrix_included",
      providerId: "anthropic", accountId: null, displayName: "Matrix AI", eligibleModelIds: [model],
      readiness: { state: "ready", checkedAt: new Date().toISOString(), staleAfter: null, action: "none", safeReason: null },
      usage: credit().usage }],
    harnesses: base.harnesses.map(harness => authenticated ? harness : { ...harness,
      enabled: true, configuredEnabled: true, authState: "authenticated", connectivity: "online",
      accessSourceId: "matrix_included", selectedAccountId: null, accountIds: [] }),
    gatewayPolicy: { accessSourceId: "matrix_included", allowedModelIds: [model], monthlyBudgetMicrousd: 5_000_000, topUpEnabled: false },
  });
}

suite("Electron Desktop combined signup fixes (synthetic gateway)", () => {
  let app: ElectronApplication;
  let page: Page;
  let gateway: Awaited<ReturnType<typeof startProviderAuthGateway>>;
  let profile: string;
  let captures: ReturnType<typeof createEvidenceDirectory>;
  let creditReads = 0;
  let settingsReads = 0;
  let mutations = 0;
  const settings = () => page.locator(".matrix-agents-providers");
  const claude = () => settings().locator(".matrix-ap-rail-item").filter({ hasText: "Claude" }).first();

  beforeAll(async () => {
    captures = createEvidenceDirectory(process.env.MATRIX_SETTINGS_EVIDENCE_DIR);
    gateway = await startProviderAuthGateway({ inlineClaude: true, settings: signupSnapshot,
      managedCredit: current => { creditReads++; return { ...credit(4_000_000), revision: current.revision }; } });
    // The fixture's default is Off. Explicitly seed a historical enabled binding
    // so the presentation guard cannot pass merely because the agent is disabled.
    const seeded = await fetch(`${gateway.url}/api/ai/provider-settings/actions`, {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ type: "set_harness_enabled", harnessInstanceId: "claude_harness", enabled: true,
        expectedRevision: 1, idempotencyKey: "combined-fixture-seed" }),
    });
    expect(seeded.ok).toBe(true);
    const seededBody = await seeded.json();
    expect(seededBody.snapshot.harnesses[0]).toMatchObject({ enabled: true, authState: "authenticated", accessSourceId: "matrix_included" });
    profile = mkdtempSync(join(tmpdir(), "matrix-signup-combined-"));
    app = await _electron.launch({ executablePath, args: [join(root, "desktop/out/main/index.js")],
      env: { ...process.env, OPERATOR_GATEWAY_URL: gateway.url, OPERATOR_USER_DATA_DIR: profile } });
    await app.evaluate(({ shell }) => { shell.openExternal = async () => {}; });
    page = await app.firstWindow();
    page.on("request", request => {
      const path = new URL(request.url()).pathname;
      if (path === "/api/ai/provider-settings" && request.method() === "GET") settingsReads++;
      if (path.startsWith("/api/ai/provider-settings") && !["GET", "OPTIONS"].includes(request.method())) mutations++;
    });
    await dismissGettingStartedOnInteraction(page);
    await page.getByRole("button", { name: /create account/i }).waitFor();
    await page.evaluate(() => window.operator.invoke("auth:start-device-flow", {}));
    await page.getByRole("button", { name: "Terminal", exact: true }).first().waitFor({ timeout: 15_000 });
    await page.evaluate(() => { const now = Date.now.bind(Date); Date.now = () => now() - 2650; });
    const identity = await app.evaluate(({ app }) => ({ appPath: app.getAppPath(), electron: process.versions.electron, chrome: process.versions.chrome }));
    expect(identity.appPath).toBe(join(root, "desktop/out/main"));
    writeFileSync(join(captures.path, "runtime.json"), JSON.stringify({ ...identity, rendererClockOffsetMs: -2650,
      backend: "synthetic isolated gateway; no real OAuth or model requests", profile: "disposable private test profile" }, null, 2));
    await page.getByRole("button", { name: "Open account menu", exact: true }).click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Agents & providers", exact: true }).click();
    await settings().getByRole("button", { name: "Refresh provider status", exact: true }).waitFor();
    await page.waitForFunction(() => {
      const button = document.querySelector<HTMLButtonElement>('.matrix-agents-providers button[aria-label="Refresh provider status"]');
      return button !== null && !button.disabled;
    });
  }, 60_000);

  afterAll(async () => {
    try { await app?.close(); }
    finally { try { await gateway?.close(); }
      finally { if (profile) rmSync(profile, { recursive: true, force: true }); captures?.cleanup(); } }
  });

  it("shows $5 credit with a slow client clock while an enabled legacy Matrix-bound Claude stays Not connected", async () => {
    try {
      await settings().getByText("$5.00", { exact: true }).first().waitFor();
      await page.screenshot({ path: join(captures.path, "00-initial-credit-slow-clock.png") });
      expect(await claude().innerText()).toContain("Not connected");
      await claude().click();
      await settings().getByRole("button", { name: /Claude account.*Use your Claude plan/ }).waitFor();
      expect(await settings().getByRole("button", { name: "Change account", exact: true }).count()).toBe(0);
      expect(await settings().getByText("Chat credit unavailable", { exact: true }).count()).toBe(0);
      expect(mutations).toBe(0);
      expect(gateway.workflowEvents).toEqual(["agent-enabled"]);
      await page.screenshot({ path: join(captures.path, "01-legacy-claude-slow-clock-credit.png") });
    } catch (error) { await page.screenshot({ path: join(captures.path, "01-failure.png") }); throw error; }
  }, 15_000);

  it("quietly renews credit under the same skew and explicitly connects only the native Claude account", async () => {
    try {
      const baseline = { settingsReads, mutations };
      await expect.poll(() => creditReads, { timeout: 50_000, interval: 500 }).toBe(1);
      await settings().getByText("$4.00", { exact: true }).first().waitFor({ timeout: 5000 });
      expect(settingsReads).toBe(baseline.settingsReads);
      expect(mutations).toBe(baseline.mutations);
      expect(await claude().innerText()).toContain("Not connected");
      expect(await claude().getAttribute("aria-expanded")).toBe("true");
      await settings().getByText("$4.00", { exact: true }).first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(captures.path, "02-quiet-credit-renewal.png") });
      await settings().getByRole("button", { name: /Claude account.*Use your Claude plan/ }).click();
      await settings().getByLabel("Paste the sign-in code", { exact: true }).fill("synthetic-fixture-code");
      await settings().getByRole("button", { name: "Finish connecting", exact: true }).click();
      await settings().getByRole("button", { name: "Disconnect", exact: true }).waitFor();
      expect(await claude().innerText()).toContain("Connected");
      const connected = await (await fetch(`${gateway.url}/api/ai/provider-settings`, { signal: AbortSignal.timeout(5000) })).json();
      expect(connected.harnesses[0]).toMatchObject({ enabled: true, configuredEnabled: true, authState: "authenticated",
        accessSourceId: "owner_claude_profile", selectedAccountId: "owner_claude_profile" });
      expect(gateway.workflowEvents).toEqual(["agent-enabled", "browser-login", "code-completed", "agent-enabled"]);
      expect(gateway.commands).toHaveLength(0);
      await page.screenshot({ path: join(captures.path, "03-explicit-native-connected.png") });
    } catch (error) { await page.screenshot({ path: join(captures.path, "02-failure.png") }); throw error; }
  }, 65_000);
});
