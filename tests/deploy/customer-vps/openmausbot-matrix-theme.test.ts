import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const script = "scripts/openmausbot/apply-matrix-theme.mjs";
const source = '[data-skin="daylight"] {\n  --color-app: #ffffff;\n}\n[data-skin="midnight"] {\n  --color-app: #000000;\n}\n';
const marker = "/* Matrix OS palettes for OpenMausBot */";

async function withFixture(styles: string, fn: (root: string, css: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "matrix-openmausbot-theme-"));
  const css = join(root, "src", "styles.css");
  try {
    await mkdir(join(root, "src", "lib"), { recursive: true });
    await mkdir(join(root, "public"));
    await mkdir(join(root, "src", "components"));
    await writeFile(join(root, "src", "components", "AttachmentPreview.tsx"), `<div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-3 backdrop-blur-sm sm:p-6"
    >
      <div
        ref={dialogRef}
        role="dialog"
      />
    </div>`);
    await writeFile(join(root, "src", "components", "ThemeRow.tsx"), '<SettingRow\n      title={t(simple ? "settings.theme.lightOrDark" : "settings.theme.title")} />');
    await writeFile(join(root, "src", "components", "SettingsSimplePages.tsx"), '<SettingRow title={t("settings.theme.title")} subtitle={hint}>');
    await writeFile(join(root, "src", "components", "SettingsModal.tsx"), '<Card title={t("settings.skin.title")} subtitle={t("settings.skin.subtitle")}>\n              <SkinPicker />\n            </Card>');

    await writeFile(join(root, "src", "lib", "brand.ts"), 'export const PRODUCT_NAME = "MausBot";\n');
    await writeFile(join(root, "index.html"), '<title>MausBot</title><meta name="apple-mobile-web-app-title" content="OpenMausBot" />\n');
    await writeFile(join(root, "public", "manifest.webmanifest"), '{"name":"OpenMausBot","short_name":"OpenMausBot","icons":[]}');
    await writeFile(join(root, "public", "app-icon.svg"), "<svg/>");
    await writeFile(join(root, "src", "lib", "browser-stream-client.ts"), 'import { t } from "./i18n";\nconst socket = new WebSocket(streamUrl());\n');
    await writeFile(join(root, "src", "lib", "desktop-connection.ts"), 'import RFB from "@novnc/novnc";\nconst client = new RFB(screen, websocket.href, options);\n');
    await writeFile(css, styles);
    await fn(root, css);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("OpenMausBot Matrix skin", () => {
  it("overlays the existing light/dark skins from Matrix tokens and preserves all upstream CSS", async () => {
    await withFixture(source, async (root, css) => {
      await run(process.execPath, [script, root]);
      const patched = await readFile(css, "utf8");
      expect(patched.startsWith(source)).toBe(true);
      expect(patched).toContain(marker);
      expect(patched).toMatch(/:root\[data-matrix-bots-skin\] \[data-matrix-image-dialog\] \{[^}]*background: var\(--color-app\)/);
      expect(patched).toMatch(/:root\[data-matrix-bots-skin\] \[data-matrix-image-dialog\] > header \{[^}]*background: var\(--color-panel\)/);
      expect(await readFile(join(root, "src", "components", "AttachmentPreview.tsx"), "utf8"))
        .toContain("data-matrix-image-dialog");
      expect(patched).toContain('--color-app: #fafafa');
      expect(patched).toContain('--color-app: #0d0c0c');
      expect(patched).toContain('--color-composer-ring');
      expect(patched).toContain('--color-ink-secondary');
      expect(patched).toContain('--color-bubble-user');
      expect(await readFile(join(root, "index.html"), "utf8")).toContain("<title>Matrix Bots</title>");
      const manifest = JSON.parse(await readFile(join(root, "public", "manifest.webmanifest"), "utf8")) as { name: string; icons: Array<{ src: string }> };
      expect(manifest.name).toBe("Matrix Bots");
      expect(manifest.icons[0]?.src).toBe("/app-icon.svg");
      expect(await readFile(join(root, "public", "app-icon.svg"), "utf8")).toContain("M48 31");
      expect(await readFile(join(root, "src", "lib", "browser-stream-client.ts"), "utf8"))
        .toContain("new WebSocket(matrixHostedWebSocketUrl(streamUrl()))");
      expect(await readFile(join(root, "src", "lib", "desktop-connection.ts"), "utf8"))
        .toContain("new RFB(screen, matrixHostedWebSocketUrl(websocket.href)");
      expect(await readFile(join(root, "src", "lib", "matrix-hosted-websocket.ts"), "utf8"))
        .toContain("matrix-bots-websocket-base");
      await run(process.execPath, [script, root]);
      expect(await readFile(css, "utf8")).toBe(patched);
    });
  });

  it("fails closed if the pinned upstream theme anchors change", async () => {
    const unsupported = source.replace("midnight", "changed");
    await withFixture(unsupported, async (root, css) => {
      await expect(run(process.execPath, [script, root])).rejects.toMatchObject({ code: 1 });
      expect(await readFile(css, "utf8")).toBe(unsupported);
    });
  });
});
