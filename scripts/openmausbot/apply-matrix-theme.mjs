import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { productColors as color, productScales as scale, radii } from "../../packages/brand/src/tokens.ts";

const sourceRoot = process.argv[2];
if (!sourceRoot) {
  console.error("Usage: node scripts/openmausbot/apply-matrix-theme.mjs <pinned-source-dir>");
  process.exit(1);
}

const marker = "/* Matrix OS palettes for OpenMausBot */";
const sourcePath = resolve(sourceRoot, "src/styles.css");
const source = await readFile(sourcePath, "utf8");
for (const skin of ["daylight", "midnight"]) {
  if (!source.includes('[data-skin="' + skin + '"] {')) {
    throw new Error("The pinned OpenMausBot stylesheet no longer declares the " + skin + " skin.");
  }
}

function declarations(dark) {
  const ink = dark ? color.paper : color.ink;
  const app = dark ? color.night : color.paper;
  const panel = dark ? scale.teal[900] : scale.neutral[50];
  const card = dark ? color.ink : color.card;
  const raised = dark ? color.ink : scale.neutral[100];
  const hover = dark ? color.darkLine : scale.neutral[200];
  const hairline = dark ? color.darkLine : color.line;
  const accent = dark ? color.greenLight : color.tealDark;
  return {
    "--code-color-scheme": dark ? "dark" : "light",
    "--color-app": app,
    "--color-panel": panel,
    "--color-frame": panel,
    "--color-card": card,
    "--color-raised": raised,
    "--color-raised-hover": hover,
    "--color-composer": dark ? card : color.paper,
    "--color-composer-ring": hairline,
    "--color-menu": dark ? card : color.paper,
    "--color-menu-hover": "color-mix(in srgb, var(--color-ink) 6%, transparent)",
    "--color-menu-active": "color-mix(in srgb, var(--color-ink) 11%, transparent)",
    "--color-inset": card,
    "--color-control": raised,
    "--color-hairline": hairline,
    "--color-edge": hairline,
    "--color-ink": ink,
    "--color-ink-secondary": dark ? scale.neutral[300] : color.muted,
    "--color-ink-tertiary": dark ? scale.neutral[300] : color.muted,
    "--color-accent": accent,
    "--color-accent-border": accent,
    "--color-accent-text": accent,
    "--color-accent-ink": dark ? color.night : color.paper,
    "--color-focus": dark ? color.goldLight : color.tealDark,
    "--color-bubble-user": dark ? color.darkLine : color.ink,
    "--color-bubble-user-ink": color.paper,
    "--color-success": dark ? color.tealLight : color.tealDark,
    "--color-success-ink": dark ? color.night : color.paper,
    "--color-danger": dark ? color.coralLight : color.coralDark,
    "--color-danger-ink": dark ? color.night : color.paper,
    "--color-warning": dark ? color.goldLight : color.goldDark,
    "--color-scrollbar": dark ? scale.neutral[600] : color.line,
    "--color-maus-line": ink,
    "--font-sans": '"Geist Variable", Geist, ui-sans-serif, system-ui, sans-serif',
    "--font-mono": '"Geist Mono Variable", "Geist Mono", ui-monospace, monospace',
    "--radius-menu": radii.card,
  };
}

function skinRule(selectors, dark) {
  const body = Object.entries(declarations(dark)).map(([property, value]) => "  " + property + ": " + value + ";");
  return selectors + " {\n" + body.join("\n") + "\n}";
}

// Keep all upstream responsive UI, locale strings, component layouts and
// optional skins. The official Daylight/Midnight choices also back "system".
const css = [
  marker,
  skinRule('[data-skin="daylight"], :root:not([data-skin])', false),
  skinRule('[data-skin="midnight"]', true),
  "@media (prefers-color-scheme: dark) {\n" + skinRule(":root:not([data-skin])", true) + "\n}",
  `:root[data-matrix-bots-skin] .matrix-hosted-bots-theme-control {
  display: none;
}

:root[data-matrix-bots-skin] [data-matrix-image-scrim] {
  background: color-mix(in srgb, #000 55%, transparent);
}

:root[data-matrix-bots-skin] [data-matrix-image-dialog] {
  background: var(--color-app);
  border-color: var(--color-hairline);
  color: var(--color-ink);
}

:root[data-matrix-bots-skin] [data-matrix-image-dialog] > header {
  background: var(--color-panel);
  border-color: var(--color-hairline);
}

:root[data-matrix-bots-skin] [data-matrix-image-dialog] > header .truncate {
  color: var(--color-ink);
}

:root[data-matrix-bots-skin] [data-matrix-image-dialog] > header .truncate + div,
:root[data-matrix-bots-skin] [data-matrix-image-dialog] [role="alert"],
:root[data-matrix-bots-skin] [data-matrix-image-dialog] [role="status"] > span {
  color: var(--color-ink-secondary);
}

:root[data-matrix-bots-skin] [data-matrix-image-dialog] [role="status"],
:root[data-matrix-bots-skin] [data-matrix-image-dialog] :is(a, button) {
  background: var(--color-raised);
  border-color: var(--color-hairline);
  color: var(--color-ink);
}

:root[data-matrix-bots-skin] [data-matrix-image-dialog] :is(a, button):hover {
  background: var(--color-raised-hover);
  color: var(--color-ink);
}`,
].join("\n\n");
const original = source.split("\n\n" + marker)[0];
await writeFile(sourcePath, original + "\n\n" + css + "\n");

const displayName = "Matrix Bots";
const brandPath = resolve(sourceRoot, "src/lib/brand.ts");
const htmlPath = resolve(sourceRoot, "index.html");
const manifestPath = resolve(sourceRoot, "public/manifest.webmanifest");
const brand = await readFile(brandPath, "utf8");
const html = await readFile(htmlPath, "utf8");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const icon = await readFile(new URL("../../shell/public/system-app-icons/v2/bots.svg", import.meta.url));

await Promise.all([
  writeFile(brandPath, brand
    .replace('export const PRODUCT_NAME = "MausBot";', 'export const PRODUCT_NAME = "Matrix Bots";')
    .replace('DEFAULT_BRAND: Brand = { name: "OpenMausBot" };', 'DEFAULT_BRAND: Brand = { name: "Matrix Bots" };')),
  writeFile(htmlPath, html
    .replace("<title>MausBot</title>", "<title>Matrix Bots</title>")
    .replace('content="OpenMausBot" />', 'content="Matrix Bots" />')
    .replace('sizes="180x180" href="/apple-touch-icon.png"', 'href="/app-icon.svg"')),
  writeFile(manifestPath, JSON.stringify({
    ...manifest, name: displayName, short_name: displayName,
    icons: [{ src: "/app-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  }, null, 2) + "\n"),
  writeFile(resolve(sourceRoot, "public/app-icon.svg"), icon),
]);

async function patchPinnedComponent(file, replacements) {
  const path = resolve(sourceRoot, "src/components", file);
  let component = await readFile(path, "utf8");
  for (const [needle, replacement] of replacements) {
    if (component.includes(replacement)) continue;
    if (component.split(needle).length !== 2) throw new Error("The pinned OpenMausBot component changed: " + file);
    component = component.replace(needle, replacement);
  }
  await writeFile(path, component);
}

await Promise.all([
  patchPinnedComponent("AttachmentPreview.tsx", [
    ['className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80', 'data-matrix-image-scrim\n      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80'],
    ['ref={dialogRef}\n        role="dialog"', 'ref={dialogRef}\n        data-matrix-image-dialog\n        role="dialog"'],
  ]),
  patchPinnedComponent("ThemeRow.tsx", [
    ['<SettingRow\n      title={t(simple', '<SettingRow\n      className="matrix-hosted-bots-theme-control"\n      title={t(simple'],
  ]),
  patchPinnedComponent("SettingsSimplePages.tsx", [
    ['<SettingRow title={t("settings.theme.title")} subtitle={hint}>', '<SettingRow className="matrix-hosted-bots-theme-control" title={t("settings.theme.title")} subtitle={hint}>'],
  ]),
  patchPinnedComponent("SettingsModal.tsx", [
    ['<Card title={t("settings.skin.title")} subtitle={t("settings.skin.subtitle")}>\n              <SkinPicker />\n            </Card>', '<div className="matrix-hosted-bots-theme-control">\n              <Card title={t("settings.skin.title")} subtitle={t("settings.skin.subtitle")}>\n                <SkinPicker />\n              </Card>\n            </div>'],
  ]),
]);

async function replaceStreamEndpoint(file, needle, replacement) {
  const path = resolve(sourceRoot, "src/lib", file);
  const text = await readFile(path, "utf8");
  if (text.includes(replacement)) return;
  if (text.split(needle).length !== 2) throw new Error("The pinned OpenMausBot stream entry changed: " + file);
  await writeFile(path, 'import { matrixHostedWebSocketUrl } from "./matrix-hosted-websocket";\n' + text.replace(needle, replacement));
}

await Promise.all([
  replaceStreamEndpoint("browser-stream-client.ts", "new WebSocket(streamUrl())", "new WebSocket(matrixHostedWebSocketUrl(streamUrl()))"),
  replaceStreamEndpoint("desktop-connection.ts", "new RFB(screen, websocket.href,", "new RFB(screen, matrixHostedWebSocketUrl(websocket.href),"),
  writeFile(resolve(sourceRoot, "src/lib/matrix-hosted-websocket.ts"), [
    "// Matrix Desktop injects the public route base. Credentials remain in the isolated native session.",
    "export function matrixHostedWebSocketUrl(raw: string): string {",
    '  if (typeof document === "undefined" || document.location.origin !== "https://matrix-bots.invalid") return raw;',
    '  const base = document.querySelector(\'meta[name="matrix-bots-websocket-base"]\')?.getAttribute("content");',
    '  if (!base || !URL.canParse(raw)) return raw;',
    '  const upstream = new URL(raw);',
    '  if (upstream.origin !== "wss://matrix-bots.invalid") return raw;',
    "  return base + upstream.pathname + upstream.search;",
    "}",
    "",
  ].join("\n")),
]);
