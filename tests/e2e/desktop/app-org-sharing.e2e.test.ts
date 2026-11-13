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
      }], members: { org_matrix: [
        { actorId: "user_owner", displayName: "App Owner", role: "org:member", joinedAt: "2026-11-12T12:00:00.000Z" },
        // An unreachable photo must fall back to initials in the real renderer.
        { actorId: "user_piers", displayName: "Piers Cole", imageUrl: "https://photos.invalid/piers.png", role: "org:admin", joinedAt: "2026-11-12T12:00:00.000Z" },
      ] }, invitations: {} },
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

  it("keeps the native app behind one owner popover, recognizes the share, and never publishes when sharing", async () => {
    await page.getByRole("button", { name: "Open App Launcher" }).click();
    await page.getByText("Pomodoro", { exact: true }).last().click();
    const trigger = page.getByRole("button", { name: "Publish app", exact: true });
    await trigger.waitFor();
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Share app" });
    await dialog.waitFor();
    const notShared = dialog.getByRole("button", { name: /Share with your organization.*Matrix Team · Not shared/ });
    await notShared.waitFor();
    expect(await page.getByRole("button", { name: "Publish app", exact: true }).count()).toBe(1);
    expect(await dialog.locator('[data-sharing-status="active"]').count()).toBe(0);
    if (evidencePath) await page.screenshot({ path: join(evidencePath, "electron-owner-org-overview-not-shared.png") });

    await notShared.click();
    const title = dialog.getByRole("heading", { name: "Organization sharing" });
    await title.waitFor();
    expect(await title.evaluate((element) => element === document.activeElement)).toBe(true);
    const controls = dialog.getByRole("region", { name: "Share with your org" });
    expect(await controls.getByText(/including guests/).count()).toBe(1);
    await controls.getByRole("button", { name: "Check collaboration" }).click();
    await controls.getByText("Ready to share").waitFor();
    if (evidencePath) await page.screenshot({ path: join(evidencePath, "electron-owner-org-ready.png") });
    await controls.getByRole("button", { name: "Share with your org" }).click();
    await controls.getByText("Shared with Matrix Team").waitFor();
    const members = dialog.getByRole("list", { name: "Members of Matrix Team" });
    await members.getByText("Piers Cole").waitFor();
    await members.getByText("PC").waitFor();
    expect(await members.locator("img").count()).toBe(0);
    if (evidencePath) await page.screenshot({ path: join(evidencePath, "electron-owner-org-details-active.png") });

    await dialog.getByRole("button", { name: "Back to sharing options" }).click();
    const shared = dialog.getByRole("button", { name: /Shared with Matrix Team/ });
    await shared.waitFor();
    expect(await shared.evaluate((element) => element === document.activeElement)).toBe(true);
    expect(await shared.locator('[data-sharing-status="active"]').count()).toBe(1);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });

    // Reopening reads the share again and recognizes it from the server, not from earlier UI state.
    await trigger.click();
    await shared.waitFor();
    if (evidencePath) await page.screenshot({ path: join(evidencePath, "electron-owner-org-overview-shared.png") });
    await shared.click();
    await controls.getByRole("button", { name: "Stop sharing" }).click();
    await controls.getByText("Sharing stopped").waitFor();
    await dialog.getByRole("button", { name: "Back to sharing options" }).click();
    await dialog.getByRole("button", { name: /Share with your organization.*Sharing stopped/ }).waitFor();
    expect(await dialog.locator('[data-sharing-status="active"]').count()).toBe(0);
    expect(await dialog.getByText("This app is private.").count()).toBe(1);
    expect(publicationMutations).toEqual([]);
  }, 90_000);

  it("slides between views normally and only fades under reduced motion", async () => {
    // Record the keyframes the renderer requests; a finished 180ms animation leaves nothing to inspect.
    await page.evaluate(() => {
      const recorded: string[] = [];
      Object.assign(window, { __shareMotion: recorded });
      const original = Element.prototype.animate;
      Element.prototype.animate = function (keyframes, options) {
        recorded.push(JSON.stringify(keyframes));
        return original.call(this, keyframes, options);
      };
    });
    const motion = () => page.evaluate(() => (window as unknown as { __shareMotion: string[] }).__shareMotion.splice(0));
    const dialog = page.getByRole("dialog", { name: "Share app" });
    const summary = dialog.getByRole("button", { name: /Share with your organization/ });
    const back = dialog.getByRole("button", { name: "Back to sharing options" });
    await summary.click();
    await back.waitFor();
    expect((await motion()).some((frames) => frames.includes("translateX(8px)"))).toBe(true);
    await back.click();
    await summary.waitFor();
    expect((await motion()).some((frames) => frames.includes("translateX(-8px)"))).toBe(true);

    await page.emulateMedia({ reducedMotion: "reduce" });
    try {
      expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
      await summary.click();
      await back.waitFor();
      if (evidencePath) await page.screenshot({ path: join(evidencePath, "electron-owner-org-details-reduced-motion.png") });
      await back.click();
      await summary.waitFor();
      const reduced = await motion();
      expect(reduced.length).toBeGreaterThanOrEqual(2);
      expect(reduced.filter((frames) => frames.includes("transform"))).toEqual([]);
    } finally {
      await page.emulateMedia({ reducedMotion: null });
    }
  }, 30_000);
});
