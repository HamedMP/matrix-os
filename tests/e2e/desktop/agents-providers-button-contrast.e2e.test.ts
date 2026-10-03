import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Browser } from "playwright";
import { chromeToSemanticVars } from "../../../desktop/src/renderer/src/design/themes/apply";
import { getThemeChrome, getUnifiedTheme } from "../../../desktop/src/renderer/src/design/themes";
import { MATRIX_OS_LIGHT_THEME, MATRIX_OS_DARK_THEME } from "../../../shell/src/lib/theme-presets";

const { chromium } = createRequire(new URL("../../../shell/package.json", import.meta.url))("@playwright/test");
let browser: Browser;
let css: string;
let desktopTokens: string;
beforeAll(async () => {
  css = await readFile(process.env.MATRIX_PROVIDER_CSS_AUDIT_PATH ?? new URL("../../../packages/ui/src/agents-providers/agents-providers.css", import.meta.url), "utf8");
  desktopTokens = await readFile(new URL("../../../desktop/src/renderer/src/design/tokens.css", import.meta.url), "utf8");
  browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}), headless: true });
});
afterAll(async () => browser?.close());

const themes = [
  ...["operator", "matrix", "true-black"].flatMap(id => ["light", "dark"].map(mode => ({
    name: `${id}-${mode}`, desktop: true, mode: getUnifiedTheme(id)[mode as "light" | "dark"] ? mode : "dark", vars: id === "matrix" ? {} : chromeToSemanticVars(getThemeChrome(id, mode as "light" | "dark")),
  }))),
  ...[MATRIX_OS_LIGHT_THEME, MATRIX_OS_DARK_THEME].map(theme => ({
    name: `web-${theme.name}`, desktop: false, mode: "light", vars: Object.fromEntries(Object.entries(theme.colors).map(([key, value]) => [`--${key}`, value])),
  })),
];
const variants = [
  { id: "secondary", className: "matrix-ap-button", scope: "" },
  { id: "primary", className: "matrix-ap-button matrix-ap-button-primary", scope: "" },
  { id: "danger", className: "matrix-ap-button matrix-ap-button-danger", scope: "" },
  { id: "gateway-primary", className: "matrix-ap-button matrix-ap-button-primary", scope: "matrix-ap-gateway matrix-ap-credit-row" },
  { id: "gateway-danger", className: "matrix-ap-button matrix-ap-button-danger", scope: "matrix-ap-gateway matrix-ap-credit-row" },
  { id: "gateway-secondary", className: "matrix-ap-button", scope: "matrix-ap-gateway matrix-ap-credit-row" },
  { id: "notice-primary", className: "matrix-ap-button matrix-ap-button-primary", scope: "matrix-ap-notice" },
  { id: "account-primary", className: "matrix-ap-button matrix-ap-button-primary", scope: "matrix-ap-account" },
  { id: "link", className: "matrix-ap-link-button", scope: "" },
  { id: "danger-link", className: "matrix-ap-link-button matrix-ap-danger-text", scope: "" },
  { id: "icon", className: "matrix-ap-icon-button", scope: "" },
  { id: "add", className: "matrix-ap-add-button", scope: "" },
  { id: "card", className: "matrix-ap-connection-choice matrix-ap-method-card", scope: "" },
  { id: "selected-card", className: "matrix-ap-connection-choice matrix-ap-method-card", scope: "", pressed: true },
  { id: "rail", className: "matrix-ap-rail-item", scope: "" },
];

it.each(themes)("keeps every button palette legible through interactions: $name", async ({ name, vars, desktop, mode }) => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<style>${desktop ? desktopTokens : ""}${css}</style><main class="matrix-agents-providers" style="background:var(--matrix-ap-overlay);padding:30px">${variants.map(v =>
      `<div class="${v.scope}"><button id="${v.id}" class="${v.className}" aria-pressed="${Boolean(v.pressed)}">${v.id.includes("card")
        ? `<span class="matrix-ap-method-icon" aria-hidden="true">♙</span><span class="matrix-ap-method-copy"><strong data-label="title">ChatGPT account <span data-label="badge" class="matrix-ap-selected-tag">Recommended</span></strong><span data-label="caption">Use your ChatGPT plan</span></span>${v.pressed ? `<span data-label="check" class="matrix-ap-method-check">✓</span>` : ""}`
        : `<span data-label="label">Open sign-in page</span><svg width="12" height="12" fill="currentColor" aria-hidden="true"><circle cx="6" cy="6" r="4" /></svg>`}</button></div>`).join("")}</main>`);
    await page.evaluate(mode => document.documentElement.setAttribute("data-theme", mode), mode);
    await page.evaluate(values => { for (const [key, value] of Object.entries(values)) document.documentElement.style.setProperty(key, value); }, vars);
    const failures: string[] = [];
    for (const variant of variants) {
      const button = page.locator(`#${variant.id}`);
      const normalContrast = new Map<string | undefined, number>();
      for (const state of ["normal", "hover", "focus", "active", "disabled"] as const) {
        await page.mouse.move(0, 0);
        await button.evaluate(element => { (element as HTMLButtonElement).disabled = false; (element as HTMLButtonElement).blur(); });
        if (state === "hover" || state === "active") await button.hover({ force: true });
        if (state === "active") await page.mouse.down();
        if (state === "focus") await button.focus();
        if (state === "disabled") await button.evaluate(element => { (element as HTMLButtonElement).disabled = true; });
        const contrasts = await button.evaluate(element => {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 1;
          const context = canvas.getContext("2d")!;
          const rgba = (color: string) => {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = color;
            context.fillRect(0, 0, 1, 1);
            return Array.from(context.getImageData(0, 0, 1, 1).data).map(v => v / 255);
          };
          const luminance = (values: number[]) => values.map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
            .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i]!, 0);
          const composite = (under: number[], over: number[]) => over.slice(0, 3).map((v, i) => v * over[3]! + under[i]! * (1 - over[3]!));
          return Array.from(element.querySelectorAll<HTMLElement>("[data-label]")).map(label => {
            const stack: number[][] = [];
            let current: Element | null = label;
            while (current) { stack.push(rgba(getComputedStyle(current).backgroundColor)); current = current.parentElement; }
            const background = stack.reverse().reduce(composite, [1, 1, 1]);
            const foreground = luminance(composite(background, rgba(getComputedStyle(label).color)));
            const bg = luminance(background);
            return { label: label.dataset.label, ratio: (Math.max(foreground, bg) + .05) / (Math.min(foreground, bg) + .05) };
          });
        });
        if (state === "active") await page.mouse.up();
        // True Black already has low-contrast accent/check palettes. Keep
        // those visible and preserve their normal contrast through interaction;
        // this regression does not claim AA or evaluate disabled group opacity.
        for (const contrast of contrasts) {
          if (state === "normal") normalContrast.set(contrast.label, contrast.ratio);
          const inheritedLowContrast = name.startsWith("true-black") &&
            (variant.id.includes("primary") || contrast.label === "check");
          const threshold = inheritedLowContrast ? Math.max(1.5, normalContrast.get(contrast.label)! * .95) : 3;
          if (contrast.ratio < threshold) failures.push(`${variant.id}/${state}/${contrast.label}: ${contrast.ratio.toFixed(2)}`);
        }
      }
    }
    expect(failures, `${name} illegible button states`).toEqual([]);
  } finally { await page.close(); }
}, 30_000);
