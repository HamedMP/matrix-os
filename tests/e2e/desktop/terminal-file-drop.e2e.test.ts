import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { createTerminalWorkspaceRoutes } from "../../../packages/gateway/src/shell/workspace-routes";
import { startStubGateway, type StubGateway } from "./fixtures/stub-gateway";

const root = resolve(__dirname, "../../..");
const main = join(root, "desktop/out/main/index.js");
const desktopRequire = createRequire(join(root, "desktop/package.json"));
const workspaceId = `tws_${"a".repeat(32)}`;
const tabId = `tt_${"1".repeat(32)}`;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jO9sAAAAASUVORK5CYII=", "base64");
if (process.env.MATRIX_DESKTOP_E2E_REQUIRED === "1" && !existsSync(main)) {
  throw new Error("Terminal file drop E2E requires bun run build:desktop");
}
const suite = existsSync(main) ? describe : describe.skip;

suite("built Electron Desktop Terminal local attachments", () => {
  let gateway: StubGateway;
  let app: ElectronApplication;
  let page: Page;
  let profile: string;
  let homePath: string;
  let uploadServer: Server;
  const uploads: Array<{ kind?: string; name: string; bytes: Buffer; path: string }> = [];
  const surface = () => page.getByTestId("desktop-terminal-app")
    .locator('[data-retained-pane][data-active="true"] [data-terminal-surface]');
  const pasteShortcut = process.platform === "darwin" ? "Meta+V" : "Control+Shift+V";

  beforeAll(async () => {
    gateway = await startStubGateway();
    profile = await mkdtemp(join(tmpdir(), "matrix-terminal-drop-profile-"));
    homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-drop-home-"));
    const routes = new Hono().route("/api/terminal", createTerminalWorkspaceRoutes({
      homePath,
      getPrincipal: () => ({ userId: "owner", source: "jwt" }),
      terminalOwnerIds: ["owner"],
      runtime: {
        listWorkspaces: vi.fn(async () => [{
          id: workspaceId, scope: "project", projectId: "matrix-os",
          tabs: [{ id: tabId, cwd: "projects/matrix-os", accessScope: "owner" }],
        }]),
        ensureWorkspace: vi.fn(), createTab: vi.fn(), deletionImpact: vi.fn(), deleteWorkspace: vi.fn(),
      } as never,
    }));
    const uploadApp = new Hono();
    uploadApp.all("*", async (c) => {
      if (c.req.method === "OPTIONS") return new Response(null, { status: 204, headers: {
        "access-control-allow-origin": "null", "access-control-allow-headers": "Content-Type, Authorization",
        "access-control-allow-methods": "POST, OPTIONS",
      } });
      const inputRequest = c.req.raw.clone();
      const response = await routes.fetch(c.req.raw);
      const result = await response.json() as { assets?: Array<{ path: string; terminalPath: string }> };
      if (response.ok && result.assets) {
        const input = await inputRequest.json() as { kind?: string; assets: Array<{ name: string; dataBase64: string }> };
        for (const [index, asset] of result.assets.entries()) {
          const bytes = await readFile(asset.terminalPath);
          expect(bytes).toEqual(Buffer.from(input.assets[index]!.dataBase64, "base64"));
          uploads.push({ kind: input.kind, name: input.assets[index]!.name, bytes, path: asset.path });
          asset.terminalPath = `/home/matrix/home/${asset.path}`;
        }
      }
      return new Response(JSON.stringify(result), { status: response.status, headers: {
        "content-type": "application/json", "access-control-allow-origin": "null", "access-control-allow-credentials": "true",
      } });
    });
    const gatewayRequire = createRequire(join(root, "packages/gateway/package.json"));
    const { serve } = gatewayRequire("@hono/node-server");
    uploadServer = serve({ fetch: uploadApp.fetch, port: 0, hostname: "127.0.0.1" });
    if (!uploadServer.listening) await new Promise<void>((resolve) => uploadServer.once("listening", resolve));
    const address = uploadServer.address();
    if (!address || typeof address === "string") throw new Error("Upload fixture did not start");
    const uploadOrigin = `http://127.0.0.1:${address.port}`;
    app = await _electron.launch({
      executablePath: desktopRequire("electron") as string,
      args: [main],
      env: { ...process.env, OPERATOR_GATEWAY_URL: gateway.url, OPERATOR_USER_DATA_DIR: profile },
    });
    page = await app.firstWindow();
    page.on("console", (message) => {
      if (message.text().startsWith("[terminal]")) console.info("Electron test console", message.text());
    });
    page.on("requestfailed", (request) => {
      if (request.url().includes("paste-assets")) console.info("Electron upload request failed", request.failure()?.errorText);
    });
    // Use the real authenticated upload route and filesystem, with the terminal
    // runtime supplied by the existing fixture. Only its test-home response
    // prefix changes to match the VPS path expected by the Electron client.
    await page.route("**/paste-assets", (route) => route.continue({ url:
      `${uploadOrigin}${new URL(route.request().url()).pathname}` }));
    await page.waitForFunction(() => typeof window.operator?.invoke === "function");
    await page.evaluate(() => window.operator.invoke("auth:start-device-flow", {}));
    const terminal = page.getByRole("button", { name: "Terminal", exact: true }).first();
    await terminal.waitFor({ timeout: 15_000 });
    await terminal.dblclick();
    await page.getByRole("button", { name: "Open matrix-task-1" }).click();
    await page.getByRole("heading", { name: "matrix-task-1" }).waitFor();
    await surface().locator(".xterm-helper-textarea").focus();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await gateway?.close();
    if (uploadServer) await new Promise<void>((resolve, reject) => uploadServer.close((error) => error ? reject(error) : resolve()));
    if (profile) await rm(profile, { recursive: true, force: true });
    if (homePath) await rm(homePath, { recursive: true, force: true });
  });

  it("pastes native clipboard text once without sending Enter", async () => {
    await expect.poll(() => gateway.state.terminalResizeEvents.length).toBeGreaterThan(0);
    const text = "local clipboard Unicode λ";
    await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), text);
    await surface().locator(".xterm-helper-textarea").focus();
    const count = gateway.state.terminalInputs.length;
    await page.keyboard.press(pasteShortcut);
    await expect.poll(() => gateway.state.terminalInputs.slice(count)).toEqual([text]);
    expect(uploads).toHaveLength(0);
  });

  it("uploads a native clipboard image with Cmd+V and inserts one remote path", async () => {
    const imageIsEmpty = await app.evaluate(({ clipboard, nativeImage }) => {
      const image = nativeImage.createFromBitmap(Buffer.from([255, 0, 0, 255]), { width: 1, height: 1 });
      clipboard.writeImage(image);
      return image.isEmpty();
    });
    expect(imageIsEmpty).toBe(false);
    await surface().locator(".xterm-helper-textarea").focus();
    const count = gateway.state.terminalInputs.length;
    const uploadCount = uploads.length;
    await page.keyboard.press(pasteShortcut);
    await expect.poll(() => uploads.length).toBe(uploadCount + 1);
    const upload = uploads[uploadCount]!;
    expect(upload.kind).toBeUndefined();
    expect(upload.bytes.subarray(0, 8)).toEqual(png.subarray(0, 8));
    await expect.poll(() => gateway.state.terminalInputs.slice(count)).toEqual([
      `\x1b[200~/home/matrix/home/${upload.path}\x1b[201~`,
    ]);
  });

  it("accepts a native mixed file drag and preserves each file's bytes and extension", async () => {
    const fixtures = [
      { name: "design.png", bytes: png },
      { name: "brief.pdf", bytes: Buffer.from("%PDF-1.7\nfixture") },
      { name: "说明.txt", bytes: Buffer.from("notes λ") },
      { name: "archive.zip", bytes: Buffer.from([0x50, 0x4b, 3, 4, 0, 255]) },
    ];
    const files: string[] = [];
    for (const fixture of fixtures) {
      const path = join(profile, fixture.name);
      await writeFile(path, fixture.bytes);
      files.push(path);
    }
    // CDP delivers Chromium's protected dragenter/dragover payload followed by
    // a real file-backed drop, rather than a hand-constructed DOM File event.
    const cdp = await page.context().newCDPSession(page);
    const box = await surface().boundingBox();
    if (!box) throw new Error("Terminal drop target is unavailable");
    const count = gateway.state.terminalInputs.length;
    const uploadCount = uploads.length;
    const data = { items: [], files, dragOperationsMask: 1 };
    for (const type of ["dragEnter", "dragOver", "drop"]) {
      await cdp.send("Input.dispatchDragEvent", { type, x: box.x + box.width / 2, y: box.y + box.height / 2, data });
    }
    await cdp.detach();
    await expect.poll(() => uploads.length).toBe(uploadCount + fixtures.length);
    const dropped = uploads.slice(uploadCount);
    for (const fixture of fixtures) {
      const uploaded = dropped.find((candidate) => candidate.name === fixture.name)!;
      expect(uploaded.kind).toBe("file");
      expect(uploaded.bytes).toEqual(fixture.bytes);
      expect(uploaded.path.endsWith(fixture.name.slice(fixture.name.lastIndexOf(".")))).toBe(true);
    }
    await expect.poll(() => gateway.state.terminalInputs.slice(count)).toHaveLength(1);
    const input = gateway.state.terminalInputs[count]!;
    expect(input).toBe(`\x1b[200~${fixtures.map((fixture) => {
      const upload = dropped.find((candidate) => candidate.name === fixture.name)!;
      return `/home/matrix/home/${upload.path}`;
    }).join(" ")}\x1b[201~`);
  });

  it.runIf(process.platform === "darwin")("uploads native Finder file-copy data on Cmd+V instead of file names", async () => {
    const names = ["IMG_0330.JPG", "说明.txt"];
    const bytes = [Buffer.from([255, 216, 255, 0]), Buffer.from("copied notes λ")];
    const paths = names.map((name) => join(profile, name));
    for (const [index, path] of paths.entries()) await writeFile(path, bytes[index]!);
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    // Write Finder's native file-list format plus textual file names, reproducing
    // the name-only fallback instead of injecting a browser ClipboardItem.
    const nativeWrite = await promisify(execFile)("/usr/bin/osascript", ["-l", "JavaScript", "-e", `
      ObjC.import('AppKit');
      var pasteboard = $.NSPasteboard.generalPasteboard;
      pasteboard.clearContents;
      pasteboard.declareTypesOwner($(['NSFilenamesPboardType', 'public.utf8-plain-text']), null);
      var ok = pasteboard.setPropertyListForType($(${JSON.stringify(paths)}), $('NSFilenamesPboardType'));
      pasteboard.setStringForType($(${JSON.stringify(names.join("\n"))}), $('public.utf8-plain-text'));
      JSON.stringify({ ok: ok, types: ObjC.deepUnwrap(pasteboard.types) });
    `], { timeout: 5_000 });
    const formats = await app.evaluate(({ clipboard }) => ({ formats: clipboard.availableFormats(),
      listBytes: clipboard.readBuffer("NSFilenamesPboardType").length, urlBytes: clipboard.readBuffer("public.file-url").length }));
    expect(JSON.parse(nativeWrite.stdout).ok).toBe(true);
    expect(formats.formats).toContain("text/uri-list");
    expect(formats.listBytes).toBeGreaterThan(0);
    const clipboardResult = await page.evaluate(() => window.operator.invoke("terminal:read-clipboard-files", {}));
    expect(clipboardResult).toMatchObject({ status: "files", files: names.map((name) => ({ name })) });
    await surface().locator(".xterm-helper-textarea").focus();
    const count = gateway.state.terminalInputs.length;
    const uploadCount = uploads.length;
    await page.keyboard.press(pasteShortcut);
    await expect.poll(() => uploads.length).toBe(uploadCount + names.length);
    const copied = uploads.slice(uploadCount);
    for (const [index, name] of names.entries()) {
      expect(copied.find((upload) => upload.name === name)?.bytes).toEqual(bytes[index]);
    }
    await expect.poll(() => gateway.state.terminalInputs.slice(count)).toEqual([
      `\x1b[200~${names.map((name) => `/home/matrix/home/${copied.find((upload) => upload.name === name)!.path}`).join(" ")}\x1b[201~`,
    ]);
  });

  it("uploads files from the small attachment action beside the pane actions", async () => {
    const count = gateway.state.terminalInputs.length;
    const uploadCount = uploads.length;
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"), page.getByRole("button", { name: "Attach files", exact: true }).click(),
    ]);
    await chooser.setFiles({ name: "selected.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-selected") });
    await expect.poll(() => uploads.length).toBe(uploadCount + 1);
    const upload = uploads[uploadCount]!;
    expect(upload.bytes).toEqual(Buffer.from("%PDF-selected"));
    expect(upload.kind).toBe("file");
    await expect.poll(() => gateway.state.terminalInputs.slice(count)).toEqual([
      `\x1b[200~/home/matrix/home/${upload.path}\x1b[201~`,
    ]);
  });
});
