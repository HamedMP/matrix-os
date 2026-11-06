import { createRequire } from "node:module";
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";

const { initialize, render } = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock("mermaid", () => ({ default: { initialize, render } }));
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); render.mockResolvedValue({ svg: "<svg/>" }); });

it("uses strict, bounded configuration with security settings protected from diagram directives", async () => {
  const { renderMermaid } = await import("@desktop/renderer/src/components/markdown/render-mermaid");
  expect(await renderMermaid("flowchart LR; A-->B")).toBe("<svg/>");
  expect(await renderMermaid("flowchart TB; B-->C")).toBe("<svg/>");
  expect(initialize).toHaveBeenCalledTimes(1);
  expect(initialize).toHaveBeenCalledWith(expect.objectContaining({
    securityLevel: "strict", startOnLoad: false, maxEdges: 500, htmlLabels: false,
    secure: expect.arrayContaining(["securityLevel", "maxTextSize", "maxEdges", "themeCSS", "htmlLabels"]),
  }));
  expect(render.mock.calls[0][0]).not.toBe(render.mock.calls[1][0]);
});

it("does not import or parse excessive diagram text", async () => {
  const { renderMermaid } = await import("@desktop/renderer/src/components/markdown/render-mermaid");
  await expect(renderMermaid("x".repeat(30_001))).rejects.toThrow("DiagramTooLarge");
  expect(initialize).not.toHaveBeenCalled();
  expect(render).not.toHaveBeenCalled();
});

it("resolves React types from the native diagram WebView in the pnpm virtual store", () => {
  const require = createRequire(realpathSync(resolve("apps/mobile/node_modules/react-native-webview/package.json")));
  expect(require.resolve("@types/react/package.json")).toContain("@types");
});
