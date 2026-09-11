import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron, chromium, type Browser, type ElectronApplication, type Page } from "playwright";
import type { PlatformDB } from "../../packages/platform/src/db.js";
import {
  LOCAL_SPEECH_FIXTURE_PORTS,
  LOCAL_SPEECH_FIXTURE_TRANSCRIPT,
  type LocalSpeechFixturePlan,
} from "./platform-speech-local-fixture.js";

export class LocalFixtureVerificationError extends Error {
  constructor(readonly code: string) {
    super("Local speech fixture verification failed");
    this.name = "LocalFixtureVerificationError";
  }
}

function syntheticWav(): Buffer {
  const sampleRate = 16_000;
  const samples = sampleRate;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVE", 8);
  bytes.write("fmt ", 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index += 1) {
    bytes.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 440 / sampleRate) * 4_096), 44 + index * 2);
  }
  return bytes;
}

function childCompletion(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveCompletion, reject) => {
    child.once("error", reject);
    child.once("close", () => resolveCompletion());
  });
}

async function verificationStep<T>(code: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error: unknown) {
    if (error instanceof LocalFixtureVerificationError) throw error;
    throw new LocalFixtureVerificationError(code);
  }
}

async function startOwnedXvfb(): Promise<{ display: string; close: () => Promise<void> } | undefined> {
  if (process.platform !== "linux" || process.env.DISPLAY) return undefined;
  const xvfb = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", "1280x800x24", "-nolisten", "tcp"], {
    stdio: ["ignore", "ignore", "ignore", "pipe"],
  });
  const displayPipe = xvfb.stdio[3];
  if (!displayPipe || typeof displayPipe === "number" || !("setEncoding" in displayPipe)) {
    throw new LocalFixtureVerificationError("xvfb_unavailable");
  }
  let output = "";
  displayPipe.setEncoding("utf8");
  const display = await Promise.race([
    new Promise<string>((resolveDisplay, reject) => {
      displayPipe.on("data", (chunk: string) => {
        output += chunk;
        if (output.length > 16) reject(new LocalFixtureVerificationError("xvfb_invalid_display"));
        const match = output.match(/^(\d+)\s/);
        if (match) resolveDisplay(`:${match[1]}`);
      });
      xvfb.once("error", () => reject(new LocalFixtureVerificationError("xvfb_unavailable")));
      xvfb.once("close", () => reject(new LocalFixtureVerificationError("xvfb_exited")));
    }),
    new Promise<never>((_, reject) => setTimeout(
      () => reject(new LocalFixtureVerificationError("xvfb_start_timeout")),
      5_000,
    )),
  ]);
  return {
    display,
    close: async () => {
      if (xvfb.exitCode === null && xvfb.signalCode === null) xvfb.kill("SIGTERM");
      await childCompletion(xvfb).catch(() => undefined);
    },
  };
}

async function launchVerificationPage(plan: LocalSpeechFixturePlan): Promise<{
  page: Page;
  close: () => Promise<void>;
}> {
  const audioPath = join(plan.homePath, "synthetic-microphone.wav");
  await writeFile(audioPath, syntheticWav());
  const commonArgs = [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    `--use-file-for-fake-audio-capture=${audioPath}`,
  ];
  const configuredChromium = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  const bundledChromium = chromium.executablePath();
  const { access } = await import("node:fs/promises");
  const chromiumPath = configuredChromium ?? bundledChromium;
  if (await access(chromiumPath).then(() => true).catch(() => false)) {
    const browser: Browser = await chromium.launch({ headless: true, executablePath: chromiumPath, args: commonArgs });
    const context = await browser.newContext({ permissions: ["microphone"] });
    return { page: await context.newPage(), close: () => browser.close() };
  }

  const xvfb = await startOwnedXvfb();
  const desktopRequire = createRequire(resolve("desktop/package.json"));
  const electronExecutable = desktopRequire("electron") as string;
  const mainPath = join(plan.homePath, "fixture-electron-main.cjs");
  await writeFile(mainPath, `
const { app, BrowserWindow, session } = require("electron");
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
app.commandLine.appendSwitch("use-file-for-fake-audio-capture", ${JSON.stringify(audioPath)});
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(permission === "media" && details.mediaTypes?.includes("audio"));
  });
  const window = new BrowserWindow({ show: true, width: 390, height: 844 });
  void window.loadURL("about:blank");
});
`);
  try {
    const app: ElectronApplication = await _electron.launch({
      executablePath: electronExecutable,
      args: [mainPath],
      env: { ...process.env, ...(xvfb ? { DISPLAY: xvfb.display } : {}) },
    });
    return {
      page: await app.firstWindow(),
      close: async () => {
        await app.close();
        await xvfb?.close();
      },
    };
  } catch (error: unknown) {
    await xvfb?.close();
    throw new LocalFixtureVerificationError(
      error instanceof Error ? "electron_browser_launch_failed" : "browser_launch_failed",
    );
  }
}

export async function verifyComposedSpeech(plan: LocalSpeechFixturePlan, db: PlatformDB): Promise<void> {
  const gatewayOrigin = `http://127.0.0.1:${LOCAL_SPEECH_FIXTURE_PORTS.gateway}`;
  const shellOrigin = `http://127.0.0.1:${LOCAL_SPEECH_FIXTURE_PORTS.shell}`;
  const unauthenticated = await fetch(`${gatewayOrigin}/api/speech/capabilities`, {
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (unauthenticated.status !== 401) {
    throw new LocalFixtureVerificationError("unauthenticated_gateway_accepted");
  }
  const authenticated = await fetch(`${shellOrigin}/api/speech/capabilities`, {
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!authenticated.ok) {
    throw new LocalFixtureVerificationError("authenticated_speech_preflight_failed");
  }

  const verification = await launchVerificationPage(plan);
  let transcriptionRequests = 0;
  verification.page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/speech/transcriptions") {
      transcriptionRequests += 1;
    }
  });
  await verification.page.route("**/*", async (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
      await route.continue();
    } else {
      await route.abort("blockedbyclient");
    }
  });
  try {
    await verificationStep("shell_navigation_failed", () =>
      verification.page.goto(`${shellOrigin}/?launch=__chat__`, {
        waitUntil: "domcontentloaded",
        timeout: 120_000,
      }));
    await verification.page.setViewportSize({ width: 390, height: 844 });
    const microphone = verification.page.getByRole("button", { name: "Start voice input" });
    await verificationStep("microphone_control_unavailable", () =>
      microphone.waitFor({ state: "visible", timeout: 120_000 }));
    await verification.page.bringToFront();
    // The intentionally blocked fake Clerk script can leave Next's development
    // error overlay above an otherwise functional fixture workspace.
    await verificationStep("microphone_start_failed", () => microphone.click({ force: true }));
    const stop = verification.page.getByRole("button", { name: "Stop recording" });
    await verificationStep("recording_did_not_start", () =>
      stop.waitFor({ state: "visible", timeout: 15_000 }));
    await verification.page.waitForTimeout(500);
    await verificationStep("recording_stop_failed", () => stop.click({ force: true }));
    const editor = verification.page.locator("textarea").last();
    await verificationStep("fixture_editor_unavailable", () =>
      editor.waitFor({ state: "visible", timeout: 15_000 }));
    await verificationStep("fixture_transcript_timeout", () => verification.page.waitForFunction(
      ({ expected }) => Array.from(document.querySelectorAll("textarea"))
        .some((candidate) => candidate.value.includes(expected)),
      { expected: LOCAL_SPEECH_FIXTURE_TRANSCRIPT },
      { timeout: 30_000 },
    ));
    const editorText = await editor.inputValue();
    if (!editorText.includes(LOCAL_SPEECH_FIXTURE_TRANSCRIPT)) {
      throw new LocalFixtureVerificationError("fixture_draft_mismatch");
    }
    if (transcriptionRequests !== 1) {
      throw new LocalFixtureVerificationError("unexpected_transcription_request_count");
    }
    const operation = await db.executor.selectFrom("speech_operations")
      .select(["execution_state", "source_kind"])
      .executeTakeFirst();
    if (operation?.execution_state !== "succeeded" || operation.source_kind !== "dictation") {
      throw new LocalFixtureVerificationError("speech_operation_not_succeeded");
    }
  } catch (error: unknown) {
    if (error instanceof LocalFixtureVerificationError) throw error;
    throw new LocalFixtureVerificationError("browser_record_stop_transcribe_failed");
  } finally {
    await verification.close();
  }
}
