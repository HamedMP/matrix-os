import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { startProviderAuthGateway } from "./fixtures/provider-auth-gateway";
import { pickerCatalog, connectedOtherProvider } from "./fixtures/chat-picker-catalog";

const root = resolve(__dirname, "../../..");
const output = join(root, "output/playwright/eng-60");
const built = existsSync(join(root, "desktop/out/main/index.js"));
if (process.env.MATRIX_DESKTOP_E2E_REQUIRED === "1" && !built) throw new Error("Required Electron build is missing");
const suite = built ? describe : describe.skip;


suite("Electron Desktop narrow Chat composer and provider connection picker", () => {
  let app: ElectronApplication;
  let page: Page;
  let profile: string;
  let gateway: Awaited<ReturnType<typeof startProviderAuthGateway>>;
  beforeAll(async () => {
    mkdirSync(output, { recursive: true });
    gateway = await startProviderAuthGateway({ catalog: pickerCatalog(), settings: connectedOtherProvider });
    profile = mkdtempSync(join(tmpdir(), "matrix-eng60-picker-"));
    app = await _electron.launch({ executablePath: createRequire(join(root, "desktop/package.json"))("electron") as string,
      args: [join(root, "desktop/out/main/index.js")],
      env: { ...process.env, OPERATOR_GATEWAY_URL: gateway.url, OPERATOR_USER_DATA_DIR: profile } });
    await app.evaluate(({ shell, BrowserWindow }) => {
      shell.openExternal = async () => {};
      BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 850);
    });
    page = await app.firstWindow();
    await page.getByRole("button", { name: /create account/i }).waitFor();
    await page.evaluate(() => window.operator.invoke("auth:start-device-flow", {}));
    await page.getByRole("dialog", { name: "Chat window", exact: true }).waitFor({ timeout: 20_000 });
    const client = await page.evaluate(() => window.operator.invoke("app:get-version", {}));
    if (process.env.MATRIX_EXPECTED_CLIENT_COMMIT) expect(client.source?.commit).toBe(process.env.MATRIX_EXPECTED_CLIENT_COMMIT);
    writeFileSync(join(output, "picker-provenance.json"), JSON.stringify({ client, runtime: "isolated provider fixture", realProviderAuth: false }, null, 2));
  }, 60_000);
  afterAll(async () => {
    await app?.close(); await gateway?.close();
    if (profile) rmSync(profile, { recursive: true, force: true });
  });

  async function resizeComposer(width: number) {
    const composer = page.locator('[data-slot="shared-chat-composer"]');
    const handle = page.getByRole("dialog", { name: "Chat window", exact: true }).getByRole("separator", { name: "Resize right", exact: true });
    const box = await composer.boundingBox();
    const edge = await handle.boundingBox();
    if (!box || !edge) throw new Error("Missing Chat resize geometry");
    await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
    await page.mouse.down();
    await page.mouse.move(edge.x + edge.width / 2 + width - box.width, edge.y + edge.height / 2, { steps: 12 });
    await page.mouse.up();
    await expect.poll(async () => (await composer.boundingBox())?.width).toBeCloseTo(width, 0);
  }

  it("compacts against the middle-column width, preserves actions and draft, and expands again", async () => {
    const chat = page.getByRole("dialog", { name: "Chat window", exact: true });
    const draft = chat.getByRole("textbox", { name: "Start a chat", exact: true });
    const picker = chat.getByRole("button", { name: "Choose model and provider", exact: true });
    await expect.poll(() => picker.getAttribute("title")).toContain("gpt-5.6-sol");
    await draft.fill("Keep this narrow-column draft");
    await resizeComposer(320);
    const measurement = await chat.locator('[data-slot="shared-chat-composer"]').evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const buttons = Array.from(element.querySelectorAll<HTMLButtonElement>("button"))
        .filter(button => button.getBoundingClientRect().width > 0)
        .map(button => { const r = button.getBoundingClientRect(); return { name: button.getAttribute("aria-label"), x: r.x, right: r.right, y: r.y, width: r.width }; });
      return { width: bounds.width, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, left: bounds.left, right: bounds.right, buttons };
    });
    writeFileSync(join(output, "composer-narrow-bounds.json"), JSON.stringify(measurement, null, 2));
    await page.screenshot({ path: join(output, "electron-composer-narrow.png") });
    expect(measurement.scrollWidth).toBe(measurement.clientWidth);
    expect(measurement.buttons.every(b => b.x >= measurement.left && b.right <= measurement.right)).toBe(true);
    const toolbar = measurement.buttons.filter(b => ["Preview Markdown", "Choose model and provider", "Open Agents & providers settings", "Send"].includes(b.name ?? ""));
    expect(Math.max(...toolbar.map(b => b.y)) - Math.min(...toolbar.map(b => b.y))).toBeLessThanOrEqual(1);
    expect(toolbar.find(b => b.name === "Choose model and provider")!.width).toBeLessThanOrEqual(64);
    await chat.getByRole("button", { name: "Preview Markdown", exact: true }).click();
    await chat.getByRole("button", { name: "Edit Markdown", exact: true }).click();
    expect(await draft.innerText()).toBe("Keep this narrow-column draft");
    await resizeComposer(680);
    expect((await picker.boundingBox())!.width).toBeGreaterThan(100);
    expect(await draft.innerText()).toBe("Keep this narrow-column draft");
    await page.screenshot({ path: join(output, "electron-composer-expanded.png") });
  }, 30_000);

  it("shows full-color disconnected providers and a prominent working Connect button when another provider is connected", async () => {
    const chat = page.getByRole("dialog", { name: "Chat window", exact: true });
    expect(await chat.getByRole("button", { name: "Connect Claude Code", exact: true }).count()).toBe(0);
    await chat.getByRole("button", { name: "Choose model and provider", exact: true }).click();
    const claude = page.getByRole("button", { name: /^Claude Code agent/ });
    const codex = page.getByRole("button", { name: /^Codex agent/ });
    expect(await claude.isEnabled()).toBe(true);
    expect(await codex.isEnabled()).toBe(true);
    const opacities = await Promise.all([claude, codex].map(button => button.evaluate(el => getComputedStyle(el).opacity)));
    await claude.click();
    const connect = page.getByRole("button", { name: "Connect Claude", exact: true });
    await connect.waitFor();
    const style = await connect.evaluate(el => ({ background: getComputedStyle(el).backgroundColor, border: getComputedStyle(el).borderStyle }));
    await page.screenshot({ path: join(output, "electron-picker-connect.png") });
    expect(opacities).toEqual(["1", "1"]);
    expect(style.background).not.toBe("rgba(0, 0, 0, 0)");
    await connect.click();
    const terminal = page.getByRole("dialog", { name: "Terminal window", exact: true });
    await terminal.waitFor();
    await terminal.getByText("Connect Claude", { exact: true }).first().waitFor();
    expect(gateway.commands).toHaveLength(1);
    expect(gateway.commands[0]).toMatchObject({ name: "Connect Claude", command: ["sh", "-lc", "claude auth login"] });
    await page.screenshot({ path: join(output, "electron-picker-terminal.png") });
    await terminal.getByRole("button", { name: "Close", exact: true }).click();
    expect(await chat.getByRole("textbox", { name: "Start a chat", exact: true }).innerText()).toBe("Keep this narrow-column draft");
  }, 30_000);

  it("retains the compact composer and readable connection action in dark appearance", async () => {
    const chat = page.getByRole("dialog", { name: "Chat window", exact: true });
    await chat.getByRole("button", { name: "Open Agents & providers settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Settings window", exact: true });
    await settings.waitFor();
    await settings.getByRole("button", { name: "Appearance", exact: true }).click();
    await settings.getByRole("button", { name: "Dark", exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    await settings.getByRole("button", { name: "Close", exact: true }).click();
    const picker = chat.getByRole("button", { name: "Choose model and provider", exact: true });
    await expect.poll(() => picker.getAttribute("title")).toContain("gpt-5.6-sol");
    await resizeComposer(320);
    expect((await picker.boundingBox())!.width).toBe(32);
    expect(await chat.getByRole("textbox", { name: "Start a chat", exact: true }).innerText()).toBe("Keep this narrow-column draft");
    const preview = await chat.getByRole("button", { name: "Preview Markdown", exact: true }).boundingBox();
    const send = await chat.getByRole("button", { name: "Send", exact: true }).boundingBox();
    expect(Math.abs(preview!.y - send!.y)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: join(output, "electron-composer-narrow-dark.png") });
    await picker.click();
    const claude = page.getByRole("button", { name: /^Claude Code agent/ });
    await claude.click();
    expect(await claude.evaluate(el => getComputedStyle(el).opacity)).toBe("1");
    expect(await page.getByRole("button", { name: "Connect Claude", exact: true }).evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
    await page.screenshot({ path: join(output, "electron-picker-connect-dark.png") });
    await page.keyboard.press("Escape");
  }, 30_000);
});
