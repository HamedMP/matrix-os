import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("Workspace Canvas retirement", () => {
  it("removes the retired product UI and renderer wiring", () => {
    for (const path of [
      "shell/src/components/workspace/WorkspaceApp.tsx",
      "shell/src/components/canvas/WorkspaceCanvas.tsx",
      "shell/src/components/canvas/WorkspaceCanvasFallbackNode.tsx",
      "shell/src/components/canvas/WorkspaceCanvasInspector.tsx",
      "shell/src/components/canvas/WorkspaceCanvasNode.tsx",
      "shell/src/components/canvas/WorkspaceCanvasToolbar.tsx",
      "shell/src/stores/workspace-canvas-store.ts",
    ]) {
      expect(existsSync(resolve(root, path)), path).toBe(false);
    }

    for (const path of [
      "shell/src/components/ShellHome.tsx",
      "shell/src/components/Desktop.tsx",
      "shell/src/components/canvas/CanvasRenderer.tsx",
      "shell/src/components/canvas/CanvasWindow.tsx",
      "shell/src/components/desktop/DesktopWindow.tsx",
      "shell/src/components/mobile/MobileShell.tsx",
    ]) {
      const source = read(path);
      expect(source, path).not.toContain("WorkspaceApp");
      expect(source, path).not.toContain("matrix:open-pr-canvas");
    }
  });

  it("keeps owner data and recovery/export compatibility code", () => {
    for (const path of [
      "packages/gateway/src/canvas/contracts.ts",
      "packages/gateway/src/canvas/repository.ts",
      "packages/gateway/src/canvas/service.ts",
      "packages/gateway/src/canvas/recovery.ts",
    ]) {
      expect(existsSync(resolve(root, path)), path).toBe(true);
    }

    const routes = read("packages/gateway/src/canvas/routes.ts");
    expect(routes).toContain('app.get("/",');
    expect(routes).toContain('app.get("/:canvasId",');
    expect(routes).toContain('app.get("/:canvasId/export",');
    expect(routes).toContain('app.delete("/:canvasId"');
  });
});
