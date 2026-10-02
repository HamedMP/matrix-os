import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { _electron, type ElectronApplication } from "playwright";
import { startStubGateway } from "../../../tests/e2e/desktop/fixtures/stub-gateway";
import { closeElectronApp } from "../../../tests/e2e/desktop/fixtures/close-electron";

it("retains candidate native app pixels and real southeast resize evidence in an isolated profile", async () => {
  const root = resolve(__dirname, "../../..");
  const evidence = process.env.MATRIX_NATIVE_EVIDENCE_DIR ?? join(root, "output/playwright/native-window-edge-evidence");
  const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  await mkdir(evidence, { recursive: true });
  const profile = await mkdtemp(join(tmpdir(), "matrix-pr2113-synthetic-"));
  const stub = await startStubGateway();
  let application: ElectronApplication | undefined;
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url!, "http://127.0.0.1").pathname;
      if (path === "/api/apps") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ apps: [{ slug: "color-lab", name: "Color Lab", file: "color-lab/index.html", category: "synthetic" }] }));
      } else if (path === "/api/apps/color-lab/session-token") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ launchUrl: "/apps/color-lab/", expiresAt: Date.now() + 3600000 }));
      } else if (path === "/apps/color-lab/") {
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(`<!doctype html><title>Fictional Color Lab fixture</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#136f63;color:white;font:20px system-ui}main{height:100%;display:grid;place-content:center;text-align:center;box-sizing:border-box;border:4px solid #f7b538}small{font-size:13px}</style><main><h1>Color Lab</h1><small>Fictional isolated app · native view</small><output id="size"></output></main><script>function size(){document.querySelector('#size').textContent=innerWidth+' × '+innerHeight}addEventListener('resize',size);size()</script>`);
      } else {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(request.headers)) if (typeof value === "string" && name !== "host") headers[name] = value;
        const result = await fetch(`${stub.url}${request.url}`, { method: request.method, headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}), signal: AbortSignal.timeout(10000) });
        response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
        response.end(Buffer.from(await result.arrayBuffer()));
      }
    } catch (error) { console.error("synthetic fixture", error); response.writeHead(500); response.end("fixture failed"); }
  });
  server.on("upgrade", (request, socket, head) => {
    const upstream = connect(stub.port, "127.0.0.1", () => {
      upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${request.rawHeaders.reduce((text, value, index, values) => index % 2 ? text : text + value + ": " + values[index + 1] + "\r\n", "")}\r\n`);
      upstream.write(head); socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy()); socket.on("error", () => upstream.destroy()); socket.on("close", () => upstream.destroy());
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    application = await _electron.launch({ executablePath: createRequire(join(root, "desktop/package.json"))("electron"), args: [join(root, "desktop/out/main/index.js")], env: { ...process.env, OPERATOR_GATEWAY_URL: url, OPERATOR_USER_DATA_DIR: profile } });
    const page = await application.firstWindow();
    await page.getByRole("button", { name: /create account/i }).waitFor();
    // Begin only the synthetic token poll, avoiding the renderer's external-browser action.
    await page.evaluate(async () => { await window.operator.invoke("auth:start-device-flow", {}); });
    const trigger = page.getByRole("button", { name: /Getting started/ });
    await trigger.waitFor({ timeout: 20000 });
    if (await page.getByRole("dialog", { name: "Getting started" }).isVisible()) await trigger.click();
    await page.getByRole("button", { name: "Open App Launcher", exact: true }).click();
    const launcher = page.getByRole("dialog", { name: "App launcher", exact: true });
    await launcher.getByRole("textbox").fill("Color Lab");
    await launcher.getByRole("button", { name: "Color Lab", exact: true }).click();
    const window = page.getByRole("dialog", { name: "Color Lab window", exact: true });
    await window.waitFor();
    const childInfo = async () => application!.evaluate(async ({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find((child: any) => child.webContents?.getURL().includes("/apps/color-lab/")) as any;
      return view ? { bounds: view.getBounds(), url: view.webContents.getURL(), loading: view.webContents.isLoadingMainFrame(), ready: await view.webContents.executeJavaScript("document.readyState") } : null;
    });
    await expect.poll(childInfo).not.toBeNull();
    await expect.poll(async () => (await childInfo())?.loading).toBe(false);
    await expect.poll(async () => (await childInfo())?.ready).toBe("complete");
    await expect.poll(async () => (await childInfo())?.bounds.width ?? 0).toBeGreaterThan(100);
    console.log("INITIAL_CHILD", JSON.stringify(await childInfo()));
    const retain = async (stage: string) => {
      const native = await application!.evaluate(async ({ BrowserWindow }) => {
        const view = BrowserWindow.getAllWindows()[0].contentView.children.find((child: any) => child.webContents?.getURL().includes("/apps/color-lab/")) as any;
        await view.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
        const image = await view.webContents.capturePage();
        return { bounds: view.getBounds(), png: image.toPNG().toString("base64"), size: image.getSize(), url: view.webContents.getURL() };
      });
      const host = await window.getByTestId("desktop-surface-content-app").locator(":scope > div").first().boundingBox();
      const frame = await window.boundingBox();
      expect(host).not.toBeNull();
      expect(native.bounds).toEqual({ x: Math.round(host!.x), y: Math.round(host!.y), width: Math.round(host!.width), height: Math.round(host!.height) });
      await writeFile(join(evidence, `${stage}-native-app.png`), Buffer.from(native.png, "base64"));
      await page.screenshot({ path: join(evidence, `${stage}-renderer-chrome.png`) });
      const { png, ...metadata } = native;
      await writeFile(join(evidence, `${stage}.json`), JSON.stringify({ ...metadata, host, frame, head: sourceHead }, null, 2));
      return metadata;
    };
    const before = await retain("before");
    const grip = await window.locator('[data-window-resize="se"]').boundingBox();
    expect(grip).not.toBeNull();
    await page.mouse.move(grip!.x + grip!.width / 2, grip!.y + grip!.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip!.x + grip!.width / 2 - 220, grip!.y + grip!.height / 2 - 180, { steps: 15 });
    await page.mouse.up();
    await expect.poll(async () => (await childInfo())!.bounds.width).toBeLessThan(before.bounds.width);
    const after = await retain("after");
    expect(after.bounds.height).toBeLessThan(before.bounds.height);
    console.log("NATIVE_EVIDENCE", JSON.stringify({ evidence, before, after }));
  } finally {
    if (application) await closeElectronApp(application);
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    await stub.close();
    await rm(profile, { recursive: true, force: true });
  }
}, 90000);
