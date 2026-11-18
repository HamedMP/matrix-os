import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentAvatar } from "../../../packages/ui/src/chat-agents/AgentAvatar";
// @ts-expect-error The Docker build entry point is a standalone Node script.
import { buildOpenMausBotHostImage } from "../../../scripts/openmausbot/build-host-image.mjs";

const run = promisify(execFile);
const script = "scripts/openmausbot/apply-matrix-theme.mjs";
const source = '[data-skin="daylight"] {\n  --color-app: #ffffff;\n}\n[data-skin="midnight"] {\n  --color-app: #000000;\n}\n';
const marker = "/* Matrix OS palettes for OpenMausBot */";
const rabbitSource = "packages/ui/src/chat-agents/RecipeRabbit.tsx";

async function withFixture(styles: string, fn: (root: string, css: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "matrix-openmausbot-theme-"));
  const css = join(root, "src", "styles.css");
  try {
    await mkdir(join(root, "src", "lib"), { recursive: true });
    await mkdir(join(root, "src", "state"));
    await mkdir(join(root, "public"));
    await mkdir(join(root, "src", "components"));
    await mkdir(join(root, "src", "components", "bot-panel"));
    await mkdir(join(root, "src", "components", "bot-settings"));
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

    await writeFile(join(root, "src", "lib", "brand.ts"), 'export interface Brand { name: string; }\nexport const PRODUCT_NAME = "MausBot";\nconst DEFAULT_BRAND: Brand = { name: "OpenMausBot" };\n  current = status;\n');
    await writeFile(join(root, "src", "state", "store.tsx"), 'import { cloudAsleep, onCloudPower } from "../lib/cloud-power";\n    const wrapped: React.Dispatch<Action> = (action) => {\n    };\n');
    await writeFile(join(root, "src", "components", "Avatar.tsx"), 'import { MASCOT_BODIES, botMascotBody } from "../../shared/mascot-bodies";\n  bot: {\n    name?: string;\n    color: MausColor;\n  };\n  if (outcome !== "flatImage") {\n    return (\n      <MausAvatar />\n    );\n  }\n');
    await writeFile(join(root, "src", "components", "SidebarConnectApps.tsx"), 'import { useStore } from "@/state/store";\n    if (state.pluginsOpen) return;\n        <span aria-hidden="true" data-app-faces="">\n        </span>\n      </>}');
    await writeFile(join(root, "src", "components", "ModelPicker.tsx"), 'import { ApiKeyHint, openKeysFor } from "./EngineSetup";\n    dispatch(openKeysFor(railInstance));\n    onManage={remote ? undefined : openEngines}\n');
    await writeFile(join(root, "src", "components", "bot-panel", "pages.tsx"), 'import { appSwitchPatch } from "@/lib/bot-app-access";\nexport function AppsPage({ bot, derived }: PageContext) {\n}\n');
    await writeFile(join(root, "src", "components", "bot-settings", "AccessSection.tsx"), 'import { useBotApps } from "./useBotApps";\nexport function McpServersCard({ bot, patch }: { bot: Bot; patch: (patch: { mcpServers: string[] | null }) => void }) {\n}\n      {shows("apps") && <div className="rounded-xl bg-card p-4">');
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
      const artwork = await readFile(join(root, "public", "app-icon.svg"), "utf8");
      const legacyAvatar = renderToStaticMarkup(createElement(AgentAvatar, {
        id: "matrix-bots", name: "Bots", category: "productivity",
      }));
      const rabbitShapes = [...legacyAvatar.matchAll(/\bd="(M[^"]+)" (?:fill|stroke)=/g)]
        .slice(0, 5).map(([, path]) => path);
      expect(rabbitShapes).toHaveLength(5);
      for (const shape of rabbitShapes) expect(artwork).toContain(`d="${shape}"`);
      expect(artwork).toContain(/--rabbit-ink:(#[0-9A-F]{6})/.exec(legacyAvatar)?.[1]);
      expect(await readFile(join(root, "src", "components", "MatrixRecipeRabbit.tsx"), "utf8"))
        .toBe(await readFile(rabbitSource, "utf8"));
      const brand = await readFile(join(root, "src", "lib", "brand.ts"), "utf8");
      expect(brand).toContain('logo: "/app-icon.svg"');
      expect(brand).toContain('status.source === "default" ? { ...status, brand: DEFAULT_BRAND } : status');
      const avatars = await readFile(join(root, "src", "components", "Avatar.tsx"), "utf8");
      expect(avatars).toContain("!profile.avatarUrl && !bot.mascotFaceColor");
      expect(avatars).toContain("bot.mascotBody === DEFAULT_MASCOT_BODY");
      expect(avatars).toContain('<RecipeRabbit id={bot.id ?? avatarName} name={avatarName} avatar />');
      expect(avatars).toContain('if (outcome !== "flatImage")');
      const store = await readFile(join(root, "src", "state", "store.tsx"), "utf8");
      expect(store).toContain('action.type === "togglePlugins"');
      expect(store).toContain('action.surface === "mcp" ? "mcps" : "services"');
      expect(store).toContain('action.section === "engines"');
      const settingLinks = await readFile(join(root, "src", "lib", "matrix-hosted-settings.ts"), "utf8");
      expect(settingLinks).toContain("https://matrix-bots-settings.invalid/");
      const tools = await readFile(join(root, "src", "components", "MatrixManagedToolSettings.tsx"), "utf8");
      expect(tools).toContain('openMatrixBotsSettings("services")');
      expect(tools).toContain('openMatrixBotsSettings("mcps")');
      expect(await readFile(join(root, "src", "components", "bot-panel", "pages.tsx"), "utf8"))
        .toContain("isMatrixHostedBots() ? <MatrixManagedToolSettings />");
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

  it("runs the theme patch using only the isolated Docker build context", async () => {
    await withFixture(source, async (root, css) => {
      await buildOpenMausBotHostImage(process.cwd(), join(root, "image.tar"), "a".repeat(40), async (
        command: string, args: string[],
      ) => {
        expect(command).toBe("docker");
        if (args[0] !== "build") return;
        const context = args.at(-1)!;
        const dockerfile = await readFile(join(context, "Dockerfile"), "utf8");
        expect(dockerfile).toContain("COPY . /matrix/");
        const stageWorkdir = /^WORKDIR (\S+)$/m.exec(dockerfile)?.[1];
        expect(stageWorkdir).toBeDefined();
        // The image stages this allowlisted context at /matrix. Run the same
        // patch with no checkout ancestors from which to resolve imports.
        const workdir = join(context, relative("/matrix", stageWorkdir!));
        await run(process.execPath, [join(workdir, "apply-matrix-theme.mjs"), root], { cwd: workdir });
      });
      expect(await readFile(css, "utf8")).toContain(marker);
      expect(await readFile(css, "utf8")).toContain("--color-app: #fafafa");
      expect(await readFile(join(root, "public", "app-icon.svg"), "utf8"))
        .toBe(await readFile("shell/public/system-app-icons/v2/bots.svg", "utf8"));
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
