import { readFile } from "node:fs/promises";
import { describe, it, expect } from "vitest";
import {
  APP_IFRAME_SANDBOX,
  injectBridgeIntoAppHtml,
} from "../../shell/src/components/app-viewer-helpers.js";
import { isAllowedBridgeFetchUrl } from "../../shell/src/components/app-viewer-bridge-policy.js";

describe("AppViewer bridged runtime loading", () => {
  it("shares app-data serialization across AppViewer lifetimes", async () => {
    const source = await readFile("shell/src/components/AppViewer.tsx", "utf8");
    const componentStart = source.indexOf("export function AppViewer");
    const moduleScope = source.slice(0, componentStart);
    const componentScope = source.slice(componentStart);

    expect(moduleScope).toContain(
      "const bridgeDataHandler = createCoalescedBridgeDataHandler(requestBridgeData);",
    );
    expect(componentScope).not.toContain("createCoalescedBridgeDataHandler(requestBridgeData)");
  });

  describe("edge-to-edge app content", () => {
    it("does not insert a sharing toolbar above the app iframe", async () => {
      const source = await readFile("shell/src/components/AppViewer.tsx", "utf8");
      expect(source).not.toContain("<FileResourceSharing");
      expect(source).toContain('className="min-h-0 w-full flex-1 border-0"');
    });
  });

  describe("iframe sandbox", () => {
    it("keeps app iframes scriptable without granting same-origin escape", () => {
      expect(APP_IFRAME_SANDBOX).toContain("allow-scripts");
      expect(APP_IFRAME_SANDBOX).toContain("allow-forms");
      expect(APP_IFRAME_SANDBOX).not.toContain("allow-same-origin");
    });

    it("injects MatrixOS bridge into srcdoc html without same-origin DOM access", () => {
      const html = "<!doctype html><html><head><title>Notes</title><script type=\"module\" crossorigin src=\"./assets/app.js\"></script><link rel=\"stylesheet\" crossorigin href=\"./assets/app.css\"></head><body><div id=\"root\"></div></body></html>";
      const result = injectBridgeIntoAppHtml(html, "notes", {}, "/apps/notes/");

      expect(result).toContain('<base href="/apps/notes/">');
      expect(result).toContain("Content-Security-Policy");
      expect(result).toContain("window.MatrixOS");
      expect(result).toContain("os:bridge-fetch");
      expect(result).toContain('src="./assets/app.js"');
      expect(result).toContain('href="./assets/app.css"');
      expect(result).toContain("crossorigin");
    });

    it("rejects retired Symphony API bridge routes", () => {
      expect(isAllowedBridgeFetchUrl("symphony", "/api/symphony/state")).toBe(false);
      expect(isAllowedBridgeFetchUrl("apps/symphony", "/api/symphony/service/start")).toBe(false);
      expect(isAllowedBridgeFetchUrl("notes", "/api/symphony/state")).toBe(false);
      expect(isAllowedBridgeFetchUrl("symphony", "https://app.matrix-os.com/api/symphony/state")).toBe(false);
      expect(isAllowedBridgeFetchUrl("symphony", "/api/auth/app-session")).toBe(false);
      expect(isAllowedBridgeFetchUrl("notes", "/api/bridge/query")).toBe(true);
    });

    it("only allows Resource Manager to bridge system activity reads", () => {
      expect(isAllowedBridgeFetchUrl("resource-manager", "/api/system/activity")).toBe(true);
      expect(isAllowedBridgeFetchUrl("apps/resource-manager", "/api/system/activity?processLimit=25")).toBe(true);
      expect(isAllowedBridgeFetchUrl("notes", "/api/system/activity")).toBe(false);
      expect(isAllowedBridgeFetchUrl("resource-manager", "/api/system/update")).toBe(false);
      expect(isAllowedBridgeFetchUrl("resource-manager", "https://app.matrix-os.com/api/system/activity")).toBe(false);
    });
  });
  it('allows bundled blob workers while keeping runtime apps opaque and network-restricted',()=>{
    const html=injectBridgeIntoAppHtml('<html><head></head><body></body></html>','chess-coach',{},'/apps/chess-coach/');
    expect(html).toContain("worker-src 'self' blob:");
    expect(html).toContain("connect-src 'self'");
    expect(APP_IFRAME_SANDBOX).not.toContain('allow-same-origin');
    expect(html).not.toContain('worker-src https:');
    expect(html).not.toContain('worker-src data:');
  });

});

it('permits owner-initiated CSV downloads without granting same-origin access',()=>{
 expect(APP_IFRAME_SANDBOX.split(' ')).toContain('allow-downloads');
 expect(APP_IFRAME_SANDBOX.split(' ')).not.toContain('allow-same-origin');
});
