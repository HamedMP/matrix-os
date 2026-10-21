import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { billingBrowser, openBilling } from "./fixtures/billing-setup-browser";

const output = process.env.BILLING_DESIGN_OUTPUT ?? resolve(__dirname, "../../output/playwright/billing-setup");
let fixture: Awaited<ReturnType<typeof billingBrowser>>;
beforeAll(async () => {
  await mkdir(output, { recursive: true });
  fixture = await billingBrowser();
}, 60_000);
afterAll(async () => { await fixture?.browser.close(); });

it.each(["default", "flat"])("keeps the %s theme's disabled navigation and backdrop transparent while retaining disabled form states", async theme => {
  const page = await openBilling(fixture, 1440, 900, `plans=1&theme=${theme}`);
  try {
    await page.screenshot({ path: join(output, "starter-desktop.png") });
    const styles = await page.evaluate(() => {
      const color = (selector: string) => getComputedStyle(document.querySelector(selector)!).backgroundColor;
      return {
        nav: color('nav button:disabled'),
        backdropAlpha: (() => {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 1;
          const context = canvas.getContext("2d")!;
          context.fillStyle = color('[aria-label="Close settings"]');
          context.fillRect(0, 0, 1, 1);
          return context.getImageData(0, 0, 1, 1).data[3]! / 255;
        })(),
        control: color('#control-probes [data-variant="default"]'),
        ghost: color('#control-probes [data-variant="ghost"]'),
        field: color('#control-probes input'),
      };
    });
    expect(styles.nav).toBe("rgba(0, 0, 0, 0)");
    expect(styles.backdropAlpha).toBeGreaterThan(0);
    expect(styles.backdropAlpha).toBeLessThan(0.5);
    expect(styles.control).toBe("rgb(225, 224, 224)");
    expect(styles.ghost).toBe("rgba(0, 0, 0, 0)");
    if (theme === "default") expect(styles.field).toBe("rgb(225, 224, 224)");
    expect(await page.getByRole("button", { name: "Appearance Locked until billing is active" }).isDisabled()).toBe(true);
    expect(await page.getByRole("button", { name: "Close", exact: true }).isDisabled()).toBe(true);
    await page.keyboard.press("Escape");
    expect(await page.getByRole("heading", { name: "Billing", exact: true }).isVisible()).toBe(true);
  } finally { await page.close(); }
});

it("gives the plans entrypoint its wallpaper and fits Starter setup in a desktop window", async () => {
  const page = await openBilling(fixture, 1440, 900);
  try {
    const wallpaper = page.getByTestId("onboarding-shell-backdrop");
    expect(await wallpaper.count()).toBe(1);
    expect(await wallpaper.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    const bounds = await page.getByRole("button", { name: "Advanced settings" }).boundingBox();
    expect(bounds!.y + bounds!.height).toBeLessThan(900 - 40);
    const heading = await page.getByRole("heading", { name: "Developer tools" }).evaluate(element => ({
      height: element.getBoundingClientRect().height,
      lineHeight: parseFloat(getComputedStyle(element).lineHeight),
    }));
    expect(heading.height).toBeLessThanOrEqual(heading.lineHeight + 1);
    expect(await page.locator("main").evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
    await page.screenshot({ path: join(output, "starter-desktop.png") });
  } finally { await page.close(); }
});

it("preserves Starter single selection, Builder multi selection, trial terms and checkout failure recovery", async () => {
  const page = await openBilling(fixture, 1440, 900);
  try {
    expect(await page.getByRole("button", { name: "Start 14-day trial" }).isVisible()).toBe(true);
    await page.locator("label").filter({ has: page.getByRole("radio", { name: "Claude Code", exact: true }) }).click();
    expect(await page.getByRole("radio", { name: "Codex", exact: true }).isChecked()).toBe(false);
    await page.locator("label").filter({ has: page.getByRole("radio", { name: "None", exact: true }) }).click();
    expect(await page.getByRole("radio", { name: "Claude Code", exact: true }).isChecked()).toBe(false);
    await page.getByRole("button", { name: /^Builder/ }).click();
    expect(await page.getByRole("checkbox", { name: "None", exact: true }).count()).toBe(0);
    for (const name of ["Codex", "Claude Code", "OpenCode", "Pi"]) {
      const choice = page.getByRole("checkbox", { name, exact: true });
      if (!(await choice.isChecked())) await page.locator("label").filter({ has: choice }).click();
    }
    expect(await page.getByRole("checkbox", { name: "Codex", exact: true }).isChecked()).toBe(true);
    expect(await page.getByRole("button", { name: "Start 3-day trial" }).isVisible()).toBe(true);
    await page.evaluate(() => Promise.allSettled(document.getAnimations().map(animation => animation.finished)));
    await page.screenshot({ path: join(output, "builder-desktop.png") });
    await page.getByRole("button", { name: "Advanced settings" }).click();
    expect(await page.getByRole("button", { name: "Change server location" }).isVisible()).toBe(true);
    await page.getByRole("button", { name: "Start 3-day trial" }).click();
    await page.getByText("Checkout is unavailable. Try again in a moment.", { exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "Start 3-day trial" }).isEnabled()).toBe(true);
  } finally { await page.close(); }
});

it.each([[390, 844], [1024, 768]])("keeps setup and checkout reachable at %i × %i", async (width, height) => {
  const page = await openBilling(fixture, width, height);
  try {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const toolLabel = page.getByText("Claude Code", { exact: true });
    expect(await toolLabel.evaluate(element => element.getBoundingClientRect().height)).toBeLessThanOrEqual(40);
    const checkout = page.getByRole("button", { name: "Start 14-day trial" });
    await checkout.scrollIntoViewIfNeeded();
    const bounds = (await checkout.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(height);
    await page.screenshot({ path: join(output, `starter-${width}-checkout.png`) });
    const plan = page.getByRole("button", { name: /^Starter/ });
    await plan.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(output, `starter-${width}.png`) });
  } finally { await page.close(); }
});

it("preserves normal Settings navigation and the desktop backdrop", async () => {
  const page = await openBilling(fixture, 1440, 900, "settings=1&plan=builder");
  try {
    expect(await page.getByTestId("onboarding-shell-backdrop").count()).toBe(0);
    expect(await page.getByRole("button", { name: "Appearance", exact: true }).isEnabled()).toBe(true);
    expect(await page.getByRole("button", { name: "Close", exact: true }).isEnabled()).toBe(true);
    expect(await page.getByRole("button", { name: "Start 3-day trial" }).isVisible()).toBe(true);
    await page.screenshot({ path: join(output, "builder-settings.png") });
  } finally { await page.close(); }
});
