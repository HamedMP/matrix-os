import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MacVerificationFilesMenuLabelSchema } from "@matrix-os/contracts";
import { Hono } from "hono";
import { _electron, type ElectronApplication } from "playwright";
import { registerFileRoutes } from "../../../../packages/gateway/src/server/file-routes.js";
import { trashList } from "../../../../packages/gateway/src/trash.js";
import { dismissGettingStartedOnInteraction } from "./getting-started.js";
import { startStubGateway, type StubGateway } from "./stub-gateway.js";

const disposable = "delete-me.txt";
const neighbor = "keep-me.txt";
const disposableBytes = "A disposable file for Mac Verification.\n";
const neighborBytes = "This neighboring file must stay unchanged.\n";
const dimensions = { width: 1280, height: 800 };
const allowedRoutes = [
  "GET /api/files/list",
  "GET /api/files/stat",
  "GET /api/files/blob",
  "POST /api/files/delete",
  "POST /api/files/trash/restore",
];

async function closeElectron(app: ElectronApplication): Promise<void> {
  const child = app.process();
  if (child.exitCode !== null || child.signalCode !== null) return;
  const controller = new AbortController();
  try {
    await Promise.race([
      app.close(),
      setTimeout(5_000, undefined, { signal: controller.signal }).then(() => {
        throw new Error("Isolated Electron did not shut down");
      }),
    ]);
  } finally {
    controller.abort();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

interface FilesVerification {
  root: string;
  electronPath: string;
  profile: string;
  png: string;
  menuLabel: string;
  video?: string;
}

async function createFilesFixture(root: string, ownerHome: string) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (!allowedRoutes.includes(`${c.req.method} ${c.req.path}`)) {
      return c.json({ error: "Not found" }, 404);
    }
    await next();
  });
  registerFileRoutes(app, { homePath: ownerHome });
  const gatewayRequire = createRequire(join(root, "packages/gateway/package.json"));
  const { getRequestListener } = gatewayRequire("@hono/node-server") as typeof import("@hono/node-server");
  return startStubGateway({
    ownerFiles: getRequestListener(app.fetch, { hostname: "127.0.0.1" }),
    identity: { userId: "mac-verification-fixture", handle: "demo", displayName: "Demo Computer" },
  });
}

/** Built native Electron UI and real Files routes; auth and the Computer are local fixtures. */
export async function verifyFilesInElectron({ root, electronPath, profile, png, menuLabel, video }: FilesVerification) {
  assert(isAbsolute(electronPath) && isAbsolute(profile) && isAbsolute(png) && extname(png) === ".png");
  assert(!video || (isAbsolute(video) && extname(video) === ".webm"));
  assert(MacVerificationFilesMenuLabelSchema.safeParse(menuLabel).success, "Invalid Files menu label");
  assert(await realpath(profile) === profile && (await readdir(profile)).length === 0, "An empty, canonical QA profile is required");
  const temp = await mkdtemp(join(await realpath(tmpdir()), "matrix-files-verification-"));
  let app: ElectronApplication | undefined;
  let fixture: StubGateway | undefined;

  try {
    const ownerHome = join(temp, "owner");
    const desktopHome = join(temp, "desktop-home");
    await Promise.all([
      mkdir(join(ownerHome, ".trash"), { recursive: true, mode: 0o700 }),
      mkdir(join(desktopHome, "Library", "Application Support"), { recursive: true, mode: 0o700 }),
    ]);
    await Promise.all([
      writeFile(join(ownerHome, disposable), disposableBytes, { flag: "wx" }),
      writeFile(join(ownerHome, neighbor), neighborBytes, { flag: "wx" }),
      writeFile(join(ownerHome, ".trash", ".manifest.json"), "[]", { flag: "wx" }),
    ]);
    fixture = await createFilesFixture(root, ownerHome);
    const unauthorized = await fetch(`${fixture.url}/api/files/list`, { signal: AbortSignal.timeout(2_000) });
    assert.equal(unauthorized.status, 401, "The test owner's Files must require device authorization");
    await unauthorized.body?.cancel();
    app = await _electron.launch({
      executablePath: electronPath,
      args: [
        "--disable-background-networking",
        "--no-proxy-server",
        // Playwright uses the Chromium test keychain for synthetic credentials.
        // This launch never opens or writes the user's macOS keychain.
        "--use-mock-keychain",
        "--host-resolver-rules=MAP * ~NOTFOUND,EXCLUDE 127.0.0.1",
        join(root, "desktop/out/main/index.js"),
      ],
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: desktopHome,
        TMPDIR: temp,
        LANG: "en_US.UTF-8",
        MATRIX_NO_TELEMETRY: "1",
        MATRIX_DESKTOP_QA_IDENTITY: "isolated",
        OPERATOR_USER_DATA_DIR: profile,
        OPERATOR_GATEWAY_URL: fixture.url,
      },
      timeout: 20_000,
      slowMo: video ? 250 : 0,
    });
    const page = await app.firstWindow({ timeout: 10_000 });
    page.setDefaultTimeout(10_000);
    await page.getByRole("heading", { name: "Welcome to Matrix OS", exact: true }).waitFor();
    assert.equal(page.url(), pathToFileURL(join(root, "desktop/out/renderer/index.html")).href);
    assert.equal(await app.evaluate(({ app }) => app.getPath("userData")), profile);
    await page.setViewportSize(dimensions);
    if (video) await page.screencast.start({ path: video, size: dimensions, quality: 90 });

    try {
      await dismissGettingStartedOnInteraction(page);
      // Complete synthetic auth through the real Electron IPC without opening
      // the user's browser or requiring (or collecting) an actual credential.
      await page.evaluate(() => window.operator.invoke("auth:start-device-flow", { intent: "sign-in" }));
      await page.waitForFunction(async () => {
        const result = await window.operator.invoke("auth:poll", {});
        if (result.status === "expired") throw new Error("Fixture Electron auth expired");
        return result.status === "authorized";
      }, undefined, { polling: 200 });
      assert.equal(fixture.state.deviceCodeRequests, 1);
      assert.equal(fixture.state.tokenRequests, 1);

      await page.getByRole("navigation", { name: "Desktop apps", exact: true })
        .getByRole("button", { name: "Files", exact: true }).dblclick();
      await page.getByRole("heading", { name: "Files", exact: true }).waitFor();
      const target = page.getByRole("button", { name: `Open ${disposable}`, exact: true });
      const adjacent = page.getByRole("button", { name: `Open ${neighbor}`, exact: true });
      await target.waitFor();
      await adjacent.waitFor();

      await target.click({ button: "right" });
      const moveToTrash = page.getByRole("menuitem", { name: menuLabel, exact: true });
      if (video) {
        await moveToTrash.waitFor();
        await setTimeout(950);
      }
      await moveToTrash.click();
      const undo = page.getByRole("button", { name: "Undo", exact: true });
      await undo.waitFor();
      await target.waitFor({ state: "detached" });
      assert(await adjacent.isVisible(), "The neighboring file should remain visible");
      await assert.rejects(lstat(join(ownerHome, disposable)), { code: "ENOENT" });
      assert.equal(await readFile(join(ownerHome, neighbor), "utf8"), neighborBytes);
      const trashed = (await trashList(ownerHome)).entries;
      assert.equal(trashed.length, 1);
      assert.equal(trashed[0]?.originalPath, disposable);
      assert.equal(await readFile(join(ownerHome, trashed[0]!.trashPath), "utf8"), disposableBytes);
      await page.screenshot({ path: png, animations: "disabled", scale: "css", timeout: 5_000 });
      if (video) await setTimeout(750);

      await undo.click();
      await target.waitFor();
      assert.equal(await readFile(join(ownerHome, disposable), "utf8"), disposableBytes);
      assert.equal(await readFile(join(ownerHome, neighbor), "utf8"), neighborBytes);
      assert.deepEqual((await trashList(ownerHome)).entries, []);
      if (video) await setTimeout(1_200);
    } finally {
      if (video) await page.screencast.stop();
    }
  } finally {
    try {
      if (app) await closeElectron(app);
    } finally {
      try {
        await fixture?.close();
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [electronPath, profile, png, menuLabel, video, extra] = process.argv.slice(2);
  if (!electronPath || !profile || !png || !menuLabel || extra !== undefined) {
    throw new Error("Expected <electronPath> <isolated-profile> <preview.png> <menuLabel> [recording.webm]");
  }
  await verifyFilesInElectron({ root: process.cwd(), electronPath, profile, png, menuLabel, video });
  console.log("Electron Desktop Files: right-click Move to Trash and Undo verified.");
}
