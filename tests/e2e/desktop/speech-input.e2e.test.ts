import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { closeElectronApp } from "./fixtures/close-electron";
import { startStubGateway, type StubGateway } from "./fixtures/stub-gateway";

const DESKTOP_MAIN = resolve(__dirname, "../../../desktop/out/main/index.js");
const desktopRequire = createRequire(resolve(__dirname, "../../../desktop/package.json"));
const ELECTRON_EXECUTABLE = desktopRequire("electron") as string;
const EVIDENCE_DIR = resolve(__dirname, "../../../output/playwright/matrix-speech");
const suite = existsSync(DESKTOP_MAIN) ? describe : describe.skip;

suite("Electron Desktop speech input", () => {
  let gateway: StubGateway;
  let app: ElectronApplication;
  let page: Page;
  let userDataDir: string;
  const speechDiagnostics: string[] = [];

  beforeAll(async () => {
    gateway = await startStubGateway({
      speechCapabilities: {
        contractVersion: 1,
        fileTranscription: {
          status: "ready",
          dictation: {
            enabled: true,
            maxBytes: 10 * 1024 * 1024,
            maxDurationMs: 120_000,
            maxTranscriptChars: 32_000,
            supportedMediaTypes: ["audio/wav"],
            languageHints: false,
          },
          ownerAudio: { enabled: false },
        },
      },
    });
    userDataDir = mkdtempSync(join(tmpdir(), "matrix-speech-electron-"));
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    app = await _electron.launch({
      executablePath: ELECTRON_EXECUTABLE,
      args: [DESKTOP_MAIN],
      env: {
        ...process.env,
        OPERATOR_GATEWAY_URL: gateway.url,
        OPERATOR_USER_DATA_DIR: userDataDir,
      },
    });
    page = await app.firstWindow();
    page.on("console", (message) => {
      if (message.text().includes("[speech-draft]")) speechDiagnostics.push(message.text());
    });
    await page.setViewportSize({ width: 1440, height: 900 });
  }, 60_000);

  afterAll(async () => {
    if (app) await closeElectronApp(app);
    await gateway?.close();
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
  });

  it("renders a single manual voice-input action at an accessible touch size", async () => {
    await page.getByRole("button", { name: "Continue in browser" }).click();
    await expect.poll(() => gateway.state.tokenRequests).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => window.operator.invoke("auth:status", {})))
      .toMatchObject({ signedIn: true });
    const chatLauncher = page.getByRole("button", { name: "Chat", exact: true });
    await chatLauncher.waitFor({ timeout: 15_000 });
    await chatLauncher.dblclick();
    await page.getByRole("heading", { name: "Chats" }).waitFor({ timeout: 10_000 });
    await expect.poll(() => gateway.state.speechCapabilityRequests).toBeGreaterThan(0);
    await expect.poll(() => speechDiagnostics).toEqual([]);
    expect(await page.evaluate(() => ({
      mediaDevices: typeof navigator.mediaDevices?.getUserMedia,
      audioContext: typeof AudioContext,
      audioWorkletNode: typeof AudioWorkletNode,
    }))).toEqual({
      mediaDevices: "function",
      audioContext: "function",
      audioWorkletNode: "function",
    });

    const microphone = page.getByRole("button", { name: "Start voice input" });
    await microphone.waitFor({ state: "visible", timeout: 15_000 });
    await expect.poll(() => microphone.count()).toBe(1);
    const box = await microphone.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(36);
    expect(box?.height).toBeGreaterThanOrEqual(36);
    await page.screenshot({ path: join(EVIDENCE_DIR, "electron-chat-speech-ready.png") });
  }, 40_000);
});
