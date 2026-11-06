import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { build as viteBuild } from "vite";
import { expect, it } from "vitest";
import type { ElectronApplication, Page } from "playwright";

const root = resolve(__dirname, "../..");
const browserRequire = createRequire(resolve(root, "packages/mcp-browser/package.json"));
const desktopRequire = createRequire(resolve(root, "desktop/package.json"));
const { _electron } = browserRequire("playwright") as typeof import("playwright");
const sonnet = "claude-sonnet-5";
const glm = "cloudflare:@cf/zai-org/glm-5.3-flash";

it.skipIf(process.env.MATRIX_MODEL_READINESS_ELECTRON !== "1")(
  "retains explicit Matrix AI model intent across outage, cold Electron relaunch and recovery",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "matrix-model-readiness-e2e-"));
    const output = resolve(root, "output/playwright/managed-model-readiness-electron");
    await mkdir(output, { recursive: true });
    let electron: ElectronApplication | undefined;
    let page: Page | undefined;
    const errors: string[] = [];
    try {
      const common = { absWorkingDir: root, bundle: true, logLevel: "silent" as const };
      await build({ ...common, entryPoints: ["desktop/src/preload/index.ts"], platform: "node", format: "cjs", external: ["electron"], outfile: join(dir, "preload.cjs") });
      await build({ ...common, entryPoints: ["tests/e2e/fixtures/managed-model-readiness-main.ts"], platform: "node", format: "cjs", external: ["electron"], outfile: join(dir, "main.cjs") });
      const { default: tailwind } = await import(pathToFileURL(desktopRequire.resolve("@tailwindcss/vite")).href);
      await viteBuild({
        configFile: false, root, logLevel: "error", plugins: [tailwind()], esbuild: { jsx: "automatic" },
        resolve: { dedupe: ["react", "react-dom"], alias: { "@renderer": resolve(root, "desktop/src/renderer/src") } },
        define: { "process.env.NODE_ENV": '"test"' },
        build: { outDir: dir, emptyOutDir: false, cssCodeSplit: false,
          lib: { entry: resolve(root, "tests/e2e/fixtures/managed-model-readiness-shell.tsx"), name: "ReadinessFixture", formats: ["iife"], fileName: () => "shell.js" },
          rollupOptions: { output: { assetFileNames: asset => asset.names.some(name => name.endsWith(".css")) ? "shell.css" : "assets/[name]-[hash][extname]" } },
        },
      });
      const launch = async () => {
        const application = await _electron.launch({ executablePath: desktopRequire("electron"), args: [join(dir, "main.cjs")],
          env: { ...process.env, MATRIX_MODEL_READINESS_FIXTURE_DATA: join(dir, "profile") } });
        electron = application;
        const window = await application.firstWindow();
        page = window;
        window.on("pageerror", error => errors.push(error.message));
        await window.getByRole("button", { name: "Choose model and provider" }).waitFor();
        return { application, window };
      };
      ({ application: electron, window: page } = await launch());
      const versions = await electron.evaluate(() => process.versions);
      const evidence = () => page!.evaluate(async () => (await fetch("/evidence")).json());
      const trigger = () => page!.getByRole("button", { name: "Choose model and provider" });
      await expect.poll(async () => trigger().getAttribute("aria-busy")).toBe("false");
      expect(await evidence()).toMatchObject({ catalog: { instances: [{ id: "matrix_pi_default", driverKind: "matrix_pi",
        availability: "unavailable", connectionState: "unavailable", unavailabilityReason: "runtime_unavailable",
        models: [{ id: sonnet, availability: "unavailable" }, { id: glm, availability: "unavailable" }] }] } });
      await trigger().click();
      const sonnetOption = page.getByRole("option", { name: "Claude Sonnet 5 via Matrix AI" });
      const glmOption = page.getByRole("option", { name: "GLM 5.3 Flash via Matrix AI" });
      expect(await sonnetOption.isEnabled()).toBe(true);
      expect(await glmOption.isEnabled()).toBe(true);
      expect(await sonnetOption.innerText()).toContain("unavailable");
      expect(await glmOption.innerText()).toContain("unavailable");
      await page.screenshot({ path: join(output, "01-outage-models-selectable.png"), fullPage: true });
      await sonnetOption.click();
      expect(await trigger().getAttribute("data-model")).toBe(sonnet);
      expect(await trigger().getAttribute("title")).toContain("Unavailable");
      expect(await page.getByRole("button", { name: "Send", exact: true }).isDisabled()).toBe(true);
      await trigger().click();
      await glmOption.click();
      expect(await trigger().getAttribute("data-model")).toBe(glm);
      expect(await trigger().getAttribute("title")).toContain("Unavailable");
      expect(await page.getByRole("button", { name: "Send", exact: true }).isDisabled()).toBe(true);
      await trigger().click();
      expect(await glmOption.getAttribute("aria-selected")).toBe("true");
      await page.screenshot({ path: join(output, "02-glm-intent-unavailable.png"), fullPage: true });
      await page.keyboard.press("Escape");
      await expect.poll(evidence).toMatchObject({ preferences: { lastComposerInstanceId: "matrix_pi_default",
        composerSelections: { matrix_pi_default: { model: glm } } } });
      await electron.close(); electron = undefined;
      ({ application: electron, window: page } = await launch());
      await expect.poll(async () => trigger().getAttribute("data-model")).toBe(glm);
      expect(await trigger().getAttribute("data-provider-instance")).toBe("matrix_pi_default");
      expect(await page.getByRole("button", { name: "Send", exact: true }).isDisabled()).toBe(true);
      await page.screenshot({ path: join(output, "03-cold-relaunch-retains-glm.png"), fullPage: true });
      const updateReadiness = async (model: string) => {
        await page!.evaluate(async value => { const response = await fetch(`/fixture/readiness?model=${encodeURIComponent(value)}`, { method: "POST" }); if (!response.ok) throw new Error("Fixture readiness update failed"); }, model);
        await page!.getByRole("button", { name: "Refresh catalog observation" }).click();
      };
      await updateReadiness(sonnet);
      await expect.poll(() => page!.getByTestId("catalog-state").textContent()).toBe("readiness-sonnet");
      expect(await trigger().getAttribute("data-model")).toBe(glm);
      expect(await trigger().getAttribute("title")).toContain("Unavailable");
      expect(await page.getByRole("button", { name: "Send", exact: true }).isDisabled()).toBe(true);
      await page.screenshot({ path: join(output, "04-peer-healthy-glm-retained.png"), fullPage: true });
      await updateReadiness(glm);
      await expect.poll(() => page!.getByTestId("catalog-state").textContent()).toBe("readiness-glm");
      expect(await trigger().getAttribute("data-model")).toBe(glm);
      expect(await trigger().getAttribute("title")).not.toContain("Unavailable");
      await expect.poll(() => page!.getByRole("button", { name: "Send", exact: true }).isEnabled()).toBe(true);
      await page.screenshot({ path: join(output, "05-selected-glm-recovered.png"), fullPage: true });
      expect(errors).toEqual([]);
      await writeFile(join(output, "evidence.json"), JSON.stringify({ scenario: "Production Electron picker, composer hook and validated disk preferences; synthetic catalog only; no model execution", versions,
        final: await evidence(), screenshots: ["01-outage-models-selectable.png", "02-glm-intent-unavailable.png", "03-cold-relaunch-retains-glm.png", "04-peer-healthy-glm-retained.png", "05-selected-glm-recovered.png"], pageErrors: errors }, null, 2));
    } catch (error) {
      await writeFile(join(output, "errors.json"), JSON.stringify(errors));
      await page?.screenshot({ path: join(output, "failure.png"), fullPage: true }).catch(() => undefined);
      throw error;
    } finally {
      await electron?.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000,
);
