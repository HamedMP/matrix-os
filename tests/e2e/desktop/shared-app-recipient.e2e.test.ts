import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import {
  CollaborationDirectSessionSchema,
  CollaborationSignedConnectionTicketSchema,
  CollaborativeAppDirectoryItemSchema,
  CollaborativeAppLaunchResponseSchema,
  CollaborativeAppQueryResponseSchema,
  type CollaborativeAppDirectoryItem,
} from "@matrix-os/contracts";
import { buildPlatformVerificationToken } from "../../../packages/platform/src/platform-token";
import { shouldAuthorizeSharedAppRequest } from "../../../desktop/src/main/embeds/web-contents-view";
import { startStubGateway, type StubGateway } from "./fixtures/stub-gateway";

// Journey: a recipient opens an owner's shared app from the Electron Desktop
// launcher. Fault protected: the native shared-app view booted the recipient's
// personal Matrix desktop (dock, system apps, "Computer unavailable") instead
// of the owner's app. Real boundaries: built Electron main/renderer, the
// launcher -> IPC -> WebContentsView path with its native bearer allowlist,
// and the production Next shell behind its real proxy.ts native-session auth.
// The fixture platform forwards the native bearer the way the platform does
// (verification token + verified user + native-session marker).

const root = resolve(import.meta.dirname, "../../..");
const main = join(root, "desktop/out/main/index.js");
const shellBuild = join(root, "shell/.next/BUILD_ID");
const required = process.env.MATRIX_DESKTOP_E2E_REQUIRED === "1";
const ready = existsSync(main) && existsSync(shellBuild);
if (required && !ready) {
  throw new Error("Run bun run build:desktop and bun run build:shell:production before the shared-app recipient journey");
}
const suite = ready ? describe : describe.skip;
const executablePath = createRequire(join(root, "desktop/package.json"))("electron") as string;
const nextBin = createRequire(join(root, "shell/package.json")).resolve("next/dist/bin/next");
const evidence = process.env.MATRIX_SHARED_APP_EVIDENCE_DIR ?? join(root, "output/playwright/shared-app-recipient");
// Under Xvfb, x11grab captures the composited window including the native
// WebContentsView, which renderer-only Playwright screenshots cannot show.
const screenCapture = Boolean(process.env.DISPLAY) && spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

const recipient = { userId: "user_piers", handle: "piers", displayName: "Piers" };
const platformSecret = "fixture-platform-secret";
const nativeToken = "stub-token-1";
const organizationId = "org_matrix_team";
const launchId = "50000000-0000-4000-8000-000000000001";
const homeRuntimeId = "vps-20000000-0000-4000-8000-000000000001";
const target: CollaborativeAppDirectoryItem = CollaborativeAppDirectoryItemSchema.parse({
  scopeId: "10000000-0000-4000-8000-000000000001",
  runtimeId: "vps:20000000-0000-4000-8000-000000000001",
  organizationId,
  authorityGeneration: 1,
  appId: "shared-tasks-lab",
  catalogId: "30000000-0000-4000-8000-000000000001",
  readinessId: "40000000-0000-4000-8000-000000000001",
  registrationIncarnation: "a".repeat(64),
  buildId: "b".repeat(64),
  shareRevision: "3",
  owner: { actorId: "user_owner", displayName: "Nima" },
});
const entryPath = `/api/collaboration/shared-apps/${target.scopeId}/runtime/${launchId}/index.html`;
// Minimal stand-in for the owner's exact shared build: it announces readiness
// through the shared-app bridge exactly like a launched build does.
const ownerAppHtml = `<!doctype html><html><head><title>Shared tasks lab</title></head>
<body style="font-family:sans-serif;margin:24px"><h1>Shared tasks lab</h1><ul><li>Draft launch notes</li><li>Review sharing</li></ul>
<script>parent.postMessage({ type: "matrix:shared-app:ready" }, "*");</script></body></html>`;

type Recorded = { method: string; path: string; url: string; native: boolean; fromSharedApp: boolean };

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((done, fail) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      try { done(body ? JSON.parse(body) as Record<string, unknown> : {}); } catch (error: unknown) { fail(error); }
    });
    req.on("error", fail);
  });
}

function proofKeyThumbprint(proofPublicKey: string): string {
  return createHash("sha256").update(Buffer.from(proofPublicKey, "base64url")).digest("base64url");
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => done(port));
    });
  });
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000), redirect: "manual" });
      if (response.status > 0) return;
    } catch (error: unknown) {
      if (!(error instanceof Error)) throw error;
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

suite("Electron Desktop shared-app recipient journey", () => {
  let app: ElectronApplication;
  let page: Page;
  let gateway: StubGateway;
  let shell: ChildProcess | undefined;
  let shellOrigin = "";
  let platformOrigin = "";
  let profile = "";
  let recording: ChildProcess | undefined;
  const requests: Recorded[] = [];
  const state = { shareActive: true, launchFailures: 0 };

  const forwardToShell = (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const headers = { ...req.headers };
    delete headers.authorization;
    delete headers["x-matrix-native-app-session"];
    delete headers["x-matrix-platform-session"];
    delete headers["x-platform-user-id"];
    delete headers["x-platform-verified"];
    if (req.headers.authorization === `Bearer ${nativeToken}`) {
      headers.authorization = `Bearer ${buildPlatformVerificationToken(recipient.handle, platformSecret)}`;
      headers["x-platform-user-id"] = recipient.userId;
      headers["x-matrix-native-app-session"] = "1";
    }
    headers.host = new URL(shellOrigin).host;
    const upstream = httpRequest(new URL(`${url.pathname}${url.search}`, shellOrigin), {
      method: req.method, headers, timeout: 30_000,
    }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    });
    upstream.on("timeout", () => upstream.destroy(new Error("Shell fixture timeout")));
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  };

  const forwardToGateway = (req: IncomingMessage, res: ServerResponse) => {
    const upstream = httpRequest(new URL(req.url ?? "/", gateway.url), {
      method: req.method, headers: req.headers, timeout: 10_000,
    }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    });
    upstream.on("timeout", () => upstream.destroy(new Error("Gateway fixture timeout")));
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  };

  const platform = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const referer = req.headers.referer ?? "";
    requests.push({
      method: req.method ?? "GET", path, url: new URL(`${path}${url.search}`, platformOrigin).href,
      native: req.headers.authorization === `Bearer ${nativeToken}`,
      fromSharedApp: path.startsWith("/shared/app/") || referer.includes("/shared/app/"),
    });
    if (req.method === "GET" && path === "/api/collaboration/shared-apps") {
      json(res, { items: state.shareActive ? [target] : [] });
      return;
    }
    if (req.method === "GET" && path === `/api/collaboration/shared-apps/${target.scopeId}`) {
      if (state.shareActive) json(res, target);
      else json(res, { error: "Not found" }, 404);
      return;
    }
    if (req.method === "POST" && path === `/api/collaboration/shared-apps/${target.scopeId}/launch`) {
      req.resume();
      if (!state.shareActive) { json(res, { error: "Not found" }, 404); return; }
      if (state.launchFailures > 0) {
        state.launchFailures -= 1;
        json(res, { error: "Unavailable" }, 503);
        return;
      }
      json(res, CollaborativeAppLaunchResponseSchema.parse({
        target: {
          kind: "shared", scopeId: target.scopeId, organizationId, appId: target.appId,
          catalogId: target.catalogId, buildId: target.buildId, name: "Shared tasks lab",
          owner: target.owner, shareRevision: target.shareRevision,
        },
        launchId, entryUrl: entryPath, expiresAt: new Date(Date.now() + 600_000).toISOString(),
      }), 201);
      return;
    }
    if (req.method === "GET" && path === entryPath) {
      res.writeHead(state.shareActive ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
      res.end(state.shareActive ? ownerAppHtml : "");
      return;
    }
    // The fixture is also the owner's home endpoint. Tickets and sessions use the
    // production schemas; event streams stay unavailable (no WebSocket upgrade),
    // which the viewer treats as reconnecting rather than access loss.
    if (req.method === "POST" && path === "/api/collaboration/connections") {
      void readBody(req).then((body) => {
        if (!state.shareActive) { json(res, { error: "Not found" }, 404); return; }
        const issuedAt = new Date();
        json(res, {
          signedTicket: CollaborationSignedConnectionTicketSchema.parse({
            ticket: {
              protocolVersion: 2, ticketId: "60000000-0000-4000-8000-000000000001", nonce: "a".repeat(64),
              actorId: recipient.userId, organizationId, resource: { scopeId: target.scopeId, kind: "app" },
              purpose: body.purpose, runtime: { runtimeId: homeRuntimeId, authorityGeneration: 1 },
              proofKeyThumbprint: proofKeyThumbprint(String(body.proofPublicKey)), maxActions: 32,
              issuedAt: issuedAt.toISOString(), expiresAt: new Date(issuedAt.getTime() + 30_000).toISOString(),
            },
            keyId: "platform", signature: "a".repeat(86),
          }),
          endpoint: { origin: platformOrigin, protocolVersion: 2 },
        }, 201);
      }, () => json(res, { error: "Invalid request" }, 400));
      return;
    }
    if (req.method === "POST" && path === "/api/collaboration/direct-sessions") {
      void readBody(req).then((body) => {
        const issuedAt = new Date();
        json(res, CollaborationDirectSessionSchema.parse({
          protocolVersion: 2, id: "70000000-0000-4000-8000-000000000001", actorId: recipient.userId, organizationId,
          scopeId: target.scopeId, runtimeId: homeRuntimeId, authorityGeneration: 1, purpose: "direct_session",
          proofKeyThumbprint: proofKeyThumbprint(String(body.proofPublicKey)),
          issuedAt: issuedAt.toISOString(), expiresAt: new Date(issuedAt.getTime() + 300_000).toISOString(),
          evidenceExpiresAt: new Date(issuedAt.getTime() + 20_000).toISOString(),
          renewAfter: new Date(issuedAt.getTime() + 240_000).toISOString(),
        }), 201);
      }, () => json(res, { error: "Invalid request" }, 400));
      return;
    }
    if (req.method === "DELETE" && path.startsWith("/api/collaboration/direct-sessions/")) {
      req.resume();
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "POST" && path === `/api/collaboration/scopes/${target.scopeId}/apps/${target.appId}/view`) {
      req.resume();
      if (!state.shareActive) { json(res, { error: "Forbidden" }, 403); return; }
      json(res, CollaborativeAppQueryResponseSchema.parse({ result: { app: target.appId }, revision: "5" }));
      return;
    }
    if (path.startsWith("/shared/") || path.startsWith("/_next/") || /\.[a-z0-9]+$/i.test(path)) {
      forwardToShell(req, res, url);
      return;
    }
    forwardToGateway(req, res);
  });

  // Evaluates in the shared-app WebContentsView, located by its exact route.
  const inSharedApp = <T>(script: string): Promise<T> => app.evaluate(async ({ webContents }, input) => {
    const view = webContents.getAllWebContents().find((contents) => contents.getURL().includes(`/shared/app/${input.scopeId}`));
    if (!view) throw new Error("shared-app view not open");
    return view.executeJavaScript(input.script, true) as Promise<T>;
  }, { scopeId: target.scopeId, script });

  const sharedAppFrameText = (): Promise<string | null> => app.evaluate(async ({ webContents }, scopeId) => {
    const view = webContents.getAllWebContents().find((contents) => contents.getURL().includes(`/shared/app/${scopeId}`));
    const frame = view?.mainFrame.frames[0];
    if (!frame) return null;
    return frame.executeJavaScript("document.body ? document.body.innerText : ''") as Promise<string>;
  }, target.scopeId);

  const captureSharedApp = async (name: string) => {
    const png = await app.evaluate(async ({ webContents }, scopeId) => {
      const view = webContents.getAllWebContents().find((contents) => contents.getURL().includes(`/shared/app/${scopeId}`));
      return view ? (await view.capturePage()).toPNG().toString("base64") : null;
    }, target.scopeId);
    if (png) writeFileSync(join(evidence, `${name}-native-view.png`), Buffer.from(png, "base64"));
    await page.screenshot({ path: join(evidence, `${name}-renderer.png`) });
    if (screenCapture) {
      spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "x11grab", "-i", process.env.DISPLAY!, "-frames:v", "1",
        join(evidence, `${name}-screen.png`)], { timeout: 15_000 });
    }
  };

  const openFromLauncher = async () => {
    await page.getByRole("button", { name: "Open App Launcher" }).click();
    await page.getByRole("button", { name: /Shared tasks lab/ }).first().click({ timeout: 20_000 });
  };

  beforeAll(async () => {
    mkdirSync(evidence, { recursive: true });
    const shellPort = await freePort();
    shellOrigin = `http://127.0.0.1:${shellPort}`;
    shell = spawn(process.execPath, [nextBin, "start", "-H", "127.0.0.1", "-p", String(shellPort)], {
      cwd: join(root, "shell"),
      env: {
        ...process.env,
        NODE_ENV: "production",
        E2E_TEST_BYPASS: "",
        MATRIX_SELF_HOSTED: "",
        MATRIX_HANDLE: recipient.handle,
        MATRIX_CLERK_USER_ID: recipient.userId,
        UPGRADE_TOKEN: buildPlatformVerificationToken(recipient.handle, platformSecret),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    shell.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[shell] ${chunk.toString()}`));
    await waitForHttp(`${shellOrigin}/_next/static/does-not-exist.js`, 60_000);

    gateway = await startStubGateway({
      identity: recipient,
      organizationManagement: {
        organizations: [{
          organizationId, name: "Matrix Team", slug: "matrix-team", role: "org:member",
          memberCount: 2, aiSubmission: "members", membershipEpoch: 1,
        }],
        members: { [organizationId]: [] },
        invitations: { [organizationId]: [] },
      },
    });
    await new Promise<void>((done) => platform.listen(0, "127.0.0.1", done));
    platformOrigin = `http://127.0.0.1:${(platform.address() as { port: number }).port}`;

    profile = mkdtempSync(join(tmpdir(), "shared-app-recipient-"));
    const launch = () => _electron.launch({
      executablePath,
      args: [resolve(import.meta.dirname, "fixtures/canonical-input-electron.mjs")],
      env: { ...process.env, OPERATOR_GATEWAY_URL: platformOrigin, OPERATOR_USER_DATA_DIR: profile },
    });
    app = await launch();
    const encrypted = await app.evaluate(async ({ app: electronApp, safeStorage }, identity) => {
      await electronApp.whenReady();
      return safeStorage.encryptString(JSON.stringify({
        accessToken: identity.token, expiresAt: Date.now() + 3_600_000, userId: identity.userId, handle: identity.handle,
      })).toString("base64");
    }, { token: nativeToken, userId: recipient.userId, handle: recipient.handle });
    writeFileSync(join(profile, "credential.bin"), Buffer.from(encrypted, "base64"));
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page.setViewportSize({ width: 1260, height: 900 });
    if (screenCapture) {
      recording = spawn("ffmpeg", ["-loglevel", "error", "-y", "-f", "x11grab", "-framerate", "10", "-i", process.env.DISPLAY!,
        "-pix_fmt", "yuv420p", join(evidence, "recipient-journey.mp4")], { stdio: ["pipe", "ignore", "inherit"] });
    }
  }, 120_000);

  afterAll(async () => {
    if (recording?.stdin) {
      const stopped = new Promise((done) => recording!.once("exit", done));
      recording.stdin.end("q");
      await Promise.race([stopped, new Promise((done) => setTimeout(done, 10_000))]);
    }
    await app?.close();
    platform.closeAllConnections();
    await new Promise<void>((done) => platform.close(() => done()));
    await gateway?.close();
    shell?.kill("SIGTERM");
    if (profile) rmSync(profile, { recursive: true, force: true });
  });

  it("opens the owner's shared app itself, not the recipient's Matrix desktop", async () => {
    await page.keyboard.press("Escape");
    await openFromLauncher();

    await expect.poll(sharedAppFrameText, { timeout: 30_000 }).toContain("Shared tasks lab");
    await expect.poll(() => inSharedApp<boolean>(
      `Boolean(document.querySelector('[data-slot="shared-app-standalone"]'))`,
    )).toBe(true);
    const chrome = await inSharedApp<{ text: string; iframeTitles: string[] }>(`({
      text: document.body.innerText,
      iframeTitles: [...document.querySelectorAll("iframe")].map((frame) => frame.title),
    })`);
    expect(chrome.iframeTitles).toEqual(["Shared tasks lab shared by Nima"]);
    expect(chrome.text).not.toMatch(/Computer unavailable|Open App Launcher|Getting started|Opening shared app/);
    await captureSharedApp("opened");

    const sharedAppRequests = requests.filter((request) => request.fromSharedApp && request.method !== "OPTIONS");
    const apiRequests = sharedAppRequests.filter((request) => !request.path.startsWith("/_next/") && !/\.[a-z0-9]+$/i.test(request.path)
      || request.path === entryPath);
    expect(apiRequests.map((request) => `${request.method} ${request.path}`)).toEqual(expect.arrayContaining([
      `GET /shared/app/${target.scopeId}`,
      `GET /api/collaboration/shared-apps/${target.scopeId}`,
      `POST /api/collaboration/shared-apps/${target.scopeId}/launch`,
      `GET ${entryPath}`,
    ]));
    // Every runtime request the native view makes is inside Electron's bearer
    // allowlist and carries the native bearer; nothing targets the personal runtime.
    for (const request of apiRequests) {
      expect(shouldAuthorizeSharedAppRequest({
        requestUrl: request.url, gatewayOrigin: platformOrigin, scopeId: target.scopeId, appId: target.appId,
        method: request.method, mainFrame: request.path !== entryPath,
      }), `${request.method} ${request.path}`).toBe(true);
      expect(request.native, `${request.method} ${request.path}`).toBe(true);
    }
    expect(sharedAppRequests.some((request) => /^\/(api\/(settings|desktop|apps|system|chats)|ws|gateway)\b/.test(request.path))).toBe(false);
  }, 90_000);

  it("reloads in place and offers a working retry when the owner's app is briefly unavailable", async () => {
    state.launchFailures = 1;
    await app.evaluate(({ webContents }, scopeId) => {
      webContents.getAllWebContents().find((contents) => contents.getURL().includes(`/shared/app/${scopeId}`))?.reload();
    }, target.scopeId);

    await expect.poll(() => inSharedApp<string>("document.body.innerText"), { timeout: 30_000 })
      .toContain("Shared app is unavailable. Try again.");
    await captureSharedApp("unavailable");
    await inSharedApp(`[...document.querySelectorAll("button")].find((button) => button.textContent === "Retry").click(); true`);

    await expect.poll(sharedAppFrameText, { timeout: 30_000 }).toContain("Shared tasks lab");
    expect(await inSharedApp<string>("document.body.innerText")).not.toContain("Try again");
  }, 90_000);

  it("denies access after the owner stops sharing", async () => {
    state.shareActive = false;
    await app.evaluate(({ webContents }, scopeId) => {
      webContents.getAllWebContents().find((contents) => contents.getURL().includes(`/shared/app/${scopeId}`))?.reload();
    }, target.scopeId);

    await expect.poll(() => inSharedApp<string>("document.body.innerText"), { timeout: 30_000 })
      .toContain("Shared app unavailable");
    expect(await sharedAppFrameText()).toBeNull();
    await captureSharedApp("stopped");
  }, 60_000);
});
