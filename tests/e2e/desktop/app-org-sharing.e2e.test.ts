import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { startStubGateway } from "./fixtures/stub-gateway";

const root = resolve(import.meta.dirname, "../../..");
const main = join(root, "desktop/out/main/index.js");
if (process.env.MATRIX_DESKTOP_E2E_REQUIRED === "1" && !existsSync(main)) {
  throw new Error("Required Electron Desktop build is missing");
}
const evidencePath = process.env.MATRIX_APP_ORG_EVIDENCE_DIR;
const build = {
  appId: "pomodoro", catalogId: "30000000-0000-4000-8000-000000000001",
  registrationIncarnation: "a".repeat(64), manifestVersion: "1.0.0", buildId: "b".repeat(64),
  manifestDigest: "c".repeat(64), schemaDigest: "d".repeat(64), assetDigest: "e".repeat(64),
  bridgeContractVersion: "matrix-app-bridge-v1", runtimeAbi: "matrix-runtime-v1",
};
const readiness = {
  readinessId: "40000000-0000-4000-8000-000000000001", build, status: "ready", revision: "2",
  checks: [{ code: "cleanup", status: "passed" }], verifiedAt: "2026-11-12T12:00:00.000Z",
};
const shareBase = {
  scopeId: "10000000-0000-4000-8000-000000000001", organizationId: "org_matrix",
  owner: { actorId: "user_owner", displayName: "App Owner" }, build,
  readinessId: readiness.readinessId, dataRevision: "5", createdAt: "2026-11-12T12:00:00.000Z",
};

describe.skipIf(!existsSync(main))("Electron owner app organization sharing", () => {
  let app: ElectronApplication;
  let page: Page;
  let profile: string;
  let gateway: Awaited<ReturnType<typeof startStubGateway>>;
  const publicationMutations: string[] = [];

  beforeAll(async () => {
    if (evidencePath) mkdirSync(evidencePath, { recursive: true });
    gateway = await startStubGateway({
      identity: { userId: "user_owner", handle: "owner", displayName: "App Owner" },
      organizationManagement: { organizations: [{
        organizationId: "org_matrix", name: "Matrix Team", slug: "matrix-team", role: "org:member",
        memberCount: 3, aiSubmission: "members", membershipEpoch: 1,
      }], members: {}, invitations: {} },
      appSharing: {
        appId: "pomodoro", organizationId: "org_matrix", registrationIncarnation: build.registrationIncarnation,
        readiness,
        activeShare: { ...shareBase, state: "active", shareRevision: "3", bindingRevision: "4", updatedAt: "2026-11-12T12:00:00.000Z" },
        stoppedShare: { ...shareBase, state: "stopped", shareRevision: "4", bindingRevision: "5", updatedAt: "2026-11-12T12:01:00.000Z" },
        preflight: { eligible: true, catalogId: build.catalogId, resourceRevision: "1",
          readinessId: readiness.readinessId, buildId: build.buildId, confirmationToken: "f".repeat(32) },
      },
    });
    profile = mkdtempSync(join(tmpdir(), "matrix-app-org-owner-"));
    app = await _electron.launch({
      executablePath: createRequire(join(root, "desktop/package.json"))("electron") as string,
      args: [main],
      ...(evidencePath ? { recordVideo: { dir: evidencePath, size: { width: 1280, height: 800 } } } : {}),
      env: { ...process.env, OPERATOR_GATEWAY_URL: gateway.url, OPERATOR_USER_DATA_DIR: profile },
    });
    page = await app.firstWindow();
    page.on("request", (request) => {
      if (request.url().includes("/api/apps/pomodoro/site") && request.method() !== "GET") {
        publicationMutations.push(request.method());
      }
    });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800));
    await page.getByRole("button", { name: /create account/i }).waitFor();
    await page.evaluate(() => window.operator.invoke("auth:start-device-flow", {}));
    await page.getByRole("button", { name: "Open account menu", exact: true }).waitFor({ timeout: 15_000 });
  }, 60_000);

  afterAll(async () => {
    try { await app?.close(); }
    finally { await gateway?.close(); if (profile) rmSync(profile, { recursive: true, force: true }); }
  });

  it("keeps the native app behind one owner popover and never publishes when sharing", async () => {
    await page.getByRole("button", { name: "Open App Launcher" }).click();
    await page.getByText("Pomodoro", { exact: true }).last().click();
    const trigger = page.getByRole("button", { name: "Publish app", exact: true });
    await trigger.waitFor();
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Share app" });
    await dialog.waitFor();
    await dialog.getByText("Matrix Team").waitFor();
    expect(await page.getByRole("button", { name: "Publish app", exact: true }).count()).toBe(1);
    expect(await dialog.getByText(/including guests/).count()).toBe(1);
    await dialog.getByRole("button", { name: "Check collaboration" }).click();
    await dialog.getByText("Ready to share").waitFor();
    if (evidencePath) await page.screenshot({ path: join(evidencePath, "electron-owner-org-ready.png") });
    await dialog.getByRole("button", { name: "Share with your org" }).click();
    await dialog.getByText("Shared with Matrix Team").waitFor();
    if (evidencePath) await page.screenshot({ path: join(evidencePath, "electron-owner-org-active.png") });
    await dialog.getByRole("button", { name: "Stop sharing" }).click();
    await dialog.getByText("Sharing stopped").waitFor();
    expect(await dialog.getByText("This app is private.").count()).toBe(1);
    expect(publicationMutations).toEqual([]);
  }, 60_000);
});
