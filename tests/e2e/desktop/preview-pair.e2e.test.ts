import { createServer } from "node:http";
import { createRequire } from "node:module";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { _electron, type ElectronApplication } from "playwright";
import { issuePreviewPairLaunch, verifyPreviewPairLaunch } from "../../../packages/platform/src/preview-pair/launch-proof.js";
import { previewPairManifestFixture } from "../../platform/preview-pair-test-support.js";
import { createPreviewPairProfile } from "../../../desktop/src/main/preview-pair-profiles.js";
import { startPreviewDesktop, previewDesktopEnvironment } from "../../../scripts/preview-pair/desktop-process.js";
import { previewDesktopReady } from "../../../scripts/preview-pair/desktop-ready.js";

const root = resolve(__dirname, "../../.."), main = join(root, "desktop/out/main/index.js");
/** Required lane: never skip. Real Electron/main/preload/renderer/AuthService and
 * owned sessions, explicit synthetic Source/provider transport. No live Clerk,
 * provisioning, model call or real collaboration acceptance is implied. */
it("isolates normal/Owner/Member Electron sessions and preserves the peer when Owner signs out", async () => {
  await readFile(main); // Missing production build is a required-lane failure.
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", timeout: 10_000 }).trim();
  const home = await mkdtemp(join(tmpdir(), "eng418-native-pair-")), applications: ElectronApplication[] = [];
  const secret = "local-test-source-secret".repeat(2), now = Date.now();
  const originalHome = process.env.HOME; process.env.HOME = home;
  const manifest: any = previewPairManifestFixture(); manifest.sourceSha = sha; manifest.platformSource.sha = sha;
  manifest.createdAt = new Date(now - 60_000).toISOString(); manifest.expiresAt = new Date(now + 3_600_000).toISOString();
  manifest.fundingExpiresAt = manifest.expiresAt;
  for (const member of Object.values(manifest.members) as any[]) {
    member.installedSha = sha; member.runningSha = sha; member.lastControlAt = new Date(now).toISOString();
    member.installedVersion = member.runningVersion = `v0.0.0-collabpair-${manifest.pairId}-g1-${sha}`;
  }
  manifest.desktopArtifacts[0] = { ...manifest.desktopArtifacts[0], platform: process.platform, arch: process.arch, sourceSha: sha, executableRelativePath: "desktop" };
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = []; let length = 0;
    for await (const part of req) { length += part.length; if (length > 16_384) { res.writeHead(413).end(); return; } parts.push(part); }
    const body = parts.length ? JSON.parse(Buffer.concat(parts).toString("utf8")) : {};
    const send = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value)); };
    if (req.url === "/source") { send({ valid: true }, verifyPreviewPairLaunch(body, secret, Date.now()) ? 200 : 404); return; }
    const role = req.url?.startsWith("/member/") ? "member" : "owner", member = manifest.members[role];
    if (req.url?.endsWith("/api/auth/device/code")) { send({ deviceCode: "fixture-device", userCode: "TEST-CODE", verificationUri: `${manifest.browserOrigin}/device`, expiresIn: 600, interval: 1 }); return; }
    if (req.url?.endsWith("/api/auth/device/token")) { send({ accessToken: `test-only-${role}-credential`, expiresAt: now + 3_600_000,
      userId: member.actorId, handle: member.handle, runtimeSlot: member.runtimeSlot }); return; }
    if (req.url?.endsWith("/api/organizations")) { send({ complete: true, organizations: [{ organizationId: manifest.organizationId, name: "Preview test organization" }] }); return; }
    send({ error: "Fixture endpoint unavailable" }, 503);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Fixture server unavailable");
  const base = `http://127.0.0.1:${address.port}`;
  const electron = createRequire(join(root, "desktop/package.json"))("electron") as string;
  try {
    // Test-only bootstrap changes transport, never production auth handlers or
    // credential stores. Exact Source signature verification remains real.
    const bootstrap = join(home, "fixture-bootstrap.mjs");
    await writeFile(bootstrap, `const actualFetch=globalThis.fetch;
globalThis.fetch=(raw,init)=>{const u=new URL(String(raw)); const c=JSON.parse(process.env.MATRIX_PREVIEW_PAIR_CONTEXT).context;
if(u.href===c.sourceOrigin+'/api/preview-pairs/launch/verify')return actualFetch(${JSON.stringify(base + "/source")},init);
if(u.origin===c.apiOrigin)return actualFetch(${JSON.stringify(base)}+'/'+c.role+u.pathname+u.search,init);
return Promise.reject(new Error('Explicit native fixture endpoint unavailable'));};
await import(${JSON.stringify(pathToFileURL(main).href)});`);
    const normal = await _electron.launch({ executablePath: electron, args: [main], env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", DISPLAY: process.env.DISPLAY ?? "", XAUTHORITY: process.env.XAUTHORITY ?? "", OPERATOR_USER_DATA_DIR: join(home, "normal") } }); applications.push(normal);
    const normalPage = await normal.firstWindow(); await normalPage.getByRole("button", { name: "Sign in", exact: true }).waitFor();
    expect(await normalPage.locator('[role="status"]').filter({ hasText: "Collaboration preview" }).count()).toBe(0);
    const opened: Record<string, { app: ElectronApplication; page: Awaited<ReturnType<ElectronApplication["firstWindow"]>> }> = {};
    for (const role of ["owner", "member"] as const) {
      const proof = issuePreviewPairLaunch({ manifest, role, platform: process.platform as "linux", arch: process.arch as "x64", sourceOrigin: "https://app.matrix-os.com" }, secret, Date.now());
      const paths = await createPreviewPairProfile(proof.context, home), ready = await previewDesktopReady(proof.context);
      try {
        const app = await _electron.launch({ executablePath: electron, args: [bootstrap], ...(process.env.MATRIX_PREVIEW_PAIR_EVIDENCE_DIR ? { recordVideo: { dir: process.env.MATRIX_PREVIEW_PAIR_EVIDENCE_DIR, size: { width: 1280, height: 800 } } } : {}), env: previewDesktopEnvironment(proof, paths.userData, ready.port) }); applications.push(app);
        const page = await app.firstWindow(); await page.getByRole("status").filter({ hasText: `Collaboration preview · ${role === "owner" ? "Owner" : "Member"}` }).waitFor();
        expect(await ready.ready).toBe(app.process().pid);
        await page.route(`${manifest.apiOrigin}/**`, async route => {
          const url = new URL(route.request().url());
          await route.fulfill({ response: await route.fetch({ url: base + "/" + role + url.pathname + url.search }) });
        });
        const actual = await app.evaluate(({ app }) => ({ userData: app.getPath("userData"), sessionData: app.getPath("sessionData") }));
        expect(actual).toEqual({ userData: paths.userData, sessionData: paths.sessionData });
        await page.evaluate(() => window.operator.invoke("auth:start-device-flow", { intent: "sign-in" }));
        await expect.poll(async () => page.evaluate(() => window.operator.invoke("auth:status", {}))).toMatchObject({ signedIn: true, userId: manifest.members[role].actorId, runtimeSlot: manifest.members[role].runtimeSlot });
        opened[role] = { app, page };
        const evidence = process.env.MATRIX_PREVIEW_PAIR_EVIDENCE_DIR;
        if (evidence) await page.screenshot({ path: join(evidence, `${role}.png`) });
      } finally { await ready.dispose(); }
    }
    const wrapper = join(home, "preview-fixture-app");
    const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    await writeFile(wrapper, "#!/bin/sh\nexec " + quote(electron) + " " + quote(bootstrap) + "\n"); await chmod(wrapper, 0o755);
    const again = issuePreviewPairLaunch({ manifest, role: "owner", platform: process.platform as "linux", arch: process.arch as "x64", sourceOrigin: "https://app.matrix-os.com" }, secret, Date.now());
    const paths = await createPreviewPairProfile(again.context, home);
    const reused = await startPreviewDesktop({ executable: wrapper, proof: again, userData: paths.userData });
    expect(reused.reused).toBe(true); expect(reused.pid).toBe(opened.owner.app.process().pid);
    await reused.stop(); // Never kills the existing app or peer.
    await opened.owner.page.evaluate(() => window.operator.invoke("auth:sign-out", {}));
    expect(await opened.member.page.evaluate(() => window.operator.invoke("auth:status", {}))).toMatchObject({ signedIn: true, userId: manifest.members.member.actorId });
    expect(await normalPage.evaluate(() => window.operator.invoke("auth:status", {}))).toMatchObject({ signedIn: false });
    expect(await opened.owner.page.evaluate(() => window.operator.invoke("auth:status", {}))).toMatchObject({ signedIn: false });
  } finally {
    for (const app of applications.reverse()) await app.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome; await rm(home, { recursive: true, force: true });
  }
}, 90_000);
