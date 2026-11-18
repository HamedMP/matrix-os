// This static helper runs in a bounded local Node child so its Chromium process
// can be stopped with the same process group as the screenshot driver.
export const capturePreviewScript = String.raw`
// Keep these imports dynamic. electron-vite's ESM shim treats static imports
// anywhere in this raw string as imports of the containing app bundle.
const { createRequire } = await import("node:module");
const { join } = await import("node:path");
const { pathToFileURL } = await import("node:url");

const source = process.cwd();
const [electronPath, profile, destination, label, operation] = process.argv.slice(1);
const loadModule = createRequire(join(source, "package.json"));
const { _electron } = loadModule("playwright");
const child = await _electron.launch({
  executablePath: electronPath,
  args: [
    "--disable-background-networking",
    "--host-resolver-rules=MAP * ~NOTFOUND,EXCLUDE 127.0.0.1",
    join(source, "desktop/out/main/index.js"),
  ],
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    LANG: "en_US.UTF-8",
    MATRIX_NO_TELEMETRY: "1",
    MATRIX_DESKTOP_QA_IDENTITY: "isolated",
    OPERATOR_USER_DATA_DIR: profile,
    OPERATOR_GATEWAY_URL: "http://127.0.0.1:9",
  },
  timeout: 20_000,
});

try {
  const window = await child.firstWindow({ timeout: 10_000 });
  await window.getByRole("heading", { name: "Welcome to Matrix OS", exact: true }).waitFor({ timeout: 8_000 });
  const expectedPage = pathToFileURL(join(source, "desktop/out/renderer/index.html"));
  const actualPage = new URL(window.url());
  const preview = await child.evaluate(({ app, BrowserWindow }) => ({
    dataDirectory: app.getPath("userData"),
    visible: BrowserWindow.getAllWindows().some(window => window.isVisible() && !window.isMinimized()),
  }));
  if (actualPage.protocol !== "file:" || actualPage.pathname !== expectedPage.pathname ||
    preview.dataDirectory !== profile || !preview.visible) {
    throw new Error("Electron preview did not use the isolated local renderer");
  }
  const caption = window.locator(".signin-eyebrow");
  if (await caption.innerText({ timeout: 5_000 }) !== label) throw new Error("Unexpected Electron preview label");
  if (operation === "verify-sign-in-recovery") {
    const signIn = window.getByRole("button", { name: "Sign in", exact: true });
    const connectionError = window.getByRole("alert").filter({
      hasText: /^Couldn't connect\. Check your connection and try again\.$/,
    });
    await signIn.click({ timeout: 5_000 });
    await connectionError.waitFor({ timeout: 12_000 });
    await signIn.and(window.locator(":enabled")).waitFor({ timeout: 5_000 });
  }
  await window.evaluate(() => document.fonts.ready);
  await window.screenshot({ path: destination, animations: "disabled", scale: "css", timeout: 5_000 });
  await window.waitForEvent("close", { timeout: 30_000 }).catch((error) => {
    if (error.name !== "TimeoutError") throw error;
  });
} finally {
  if (child.process().exitCode === null) await child.close();
}
`;
