import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createSourceFile, isFunctionDeclaration, ScriptKind, ScriptTarget, transpileModule } from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareAppBridgeFetch, readAppBridgeResponse, appBridgeTimeoutMs } from "../../shell/src/components/app-capability-request";
import { prepareBridgeFetchRequest, resolveBridgeFetchUrl } from "../../shell/src/components/app-viewer-bridge-request";
import { isAllowedBridgeFetchUrl } from "../../shell/src/components/app-viewer-bridge-policy";
import { getGatewayUrl } from "../../shell/src/lib/gateway";

const gatewayCallers = [
  "shell/src/hooks/useOnboarding.ts",
  "shell/src/components/onboarding/GettingStartedPopover.tsx",
  "shell/src/lib/posthog-client.ts",
  "shell/src/lib/file-blob.ts",
] as const;

describe("explicit computer API isolation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.doUnmock("@clerk/nextjs/server");
    vi.doUnmock("next/server");
  });
  it.each(gatewayCallers)("routes gateway-owned calls through getGatewayUrl in %s", (path) => {
    const source = readFileSync(path, "utf8");

    expect(source).toContain("getGatewayUrl");
    expect(source).not.toMatch(
      /fetch\((?:"|'|`)\/api\/(?:agents|client-errors|github|onboarding|projects|workspace)/,
    );
  });

  it("routes runtime-app bridge calls through the current explicit computer gateway with trusted request preparation", async () => {
    const source = readFileSync("shell/src/components/AppViewer.tsx", "utf8");
    expect(source).toContain('const baseHref = `${GATEWAY_URL}/apps/${slug}/`;');
    expect(source).not.toContain('const baseHref = `/apps/${slug}/`;');

    // Execute the actual non-exported host handler, without mounting the UI or
    // copying its request logic into the test. Its dependencies remain real.
    const parsed = createSourceFile("AppViewer.tsx", source, ScriptTarget.Latest, true, ScriptKind.TSX);
    const handler = parsed.statements.find(statement => isFunctionDeclaration(statement) && statement.name?.text === "handleBridgeFetch");
    expect(handler).toBeDefined();
    const location = { origin: "https://matrix.test", pathname: "/vm/computer-a/canvas", search: "?runtime=review" };
    vi.stubGlobal("window", { location });
    vi.stubEnv("GATEWAY_URL", "https://default-computer.invalid");
    const fetcher = vi.fn(async () => Response.json({ services: [] }));
    const handleBridgeFetch = runInNewContext(transpileModule(`${handler!.getText(parsed)}\nhandleBridgeFetch;`, {
      compilerOptions: { target: ScriptTarget.ES2022 },
    }).outputText, {
      prepareAppBridgeFetch, prepareBridgeFetchRequest, resolveBridgeFetchUrl, readAppBridgeResponse, appBridgeTimeoutMs, isAllowedBridgeFetchUrl,
      getGatewayUrl, fetch: fetcher, AbortSignal, console,
      GATEWAY_URL: "https://matrix.test/vm/stale-computer",
    }) as (app: string, payload: unknown, port: { postMessage: (value: unknown) => void; close: () => void }, signal: AbortSignal) => Promise<void>;

    for (const [computer, runtime] of [["computer-a", "review"], ["computer-b", "primary"]]) {
      location.pathname = `/vm/${computer}/desktop`;
      location.search = `?runtime=${runtime}`;
      const port = { postMessage: vi.fn(), close: vi.fn() };
      await handleBridgeFetch("games/chess", {
        url: "/api/bridge/service", init: {
          method: "POST", headers: { authorization: "Bearer page-token", "x-platform-user-id": "page-owner" },
          body: JSON.stringify({ app: "other-app", service: "google-drive", action: "list_files" }),
        },
      }, port, new AbortController().signal);
      const [url, init] = fetcher.mock.calls.at(-1)! as unknown as [string, RequestInit];
      expect(url).toBe(`https://matrix.test/vm/${computer}/~runtime/${runtime}/api/bridge/capabilities`);
      expect(init.headers).toEqual({ "content-type": "application/json" });
      expect(JSON.parse(init.body as string)).toEqual({ app: "games/chess", input: { kind: "integrations.call", service: "google-drive", action: "list_files" } });
      expect(init.redirect).toBe("error");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(port.postMessage).toHaveBeenCalledWith({ ok: true, status: 200, body: { services: [] } });
      expect(port.close).toHaveBeenCalledOnce();
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["owner", "other-owner", null])("only injects authenticated gateway owner headers for session %s", async (userId) => {
    vi.stubEnv("MATRIX_CLERK_USER_ID", "owner");
    vi.stubEnv("MATRIX_AUTH_TOKEN", "trusted-owner-gateway-token");
    vi.stubEnv("GATEWAY_URL", "http://selected-computer.internal:4000");
    vi.stubEnv("MATRIX_SELF_HOSTED", "0");
    vi.stubEnv("E2E_TEST_BYPASS", "0");
    vi.stubEnv("UPGRADE_TOKEN", "");
    vi.doMock("@clerk/nextjs/server", () => ({ clerkMiddleware: (handler: Function) => (request: unknown) => handler(async () => ({ userId }), request) }));
    const rewrite = vi.fn((url: URL, init: { request: { headers: Headers } }) => ({ url, init }));
    class MockNextResponse extends Response {
      static rewrite = rewrite;
      static redirect = vi.fn(() => new Response(null, { status: 307 }));
      static next = vi.fn(() => new Response());
    }
    vi.doMock("next/server", () => ({ NextResponse: MockNextResponse }));
    const { proxy } = await import("../../shell/src/proxy");
    // The platform resolves the explicit computer prefix before this trusted
    // selected-computer shell hop. Auth secrets are added here, never by apps.
    const request = {
      url: "https://matrix.test/api/bridge/capabilities",
      headers: new Headers({ authorization: "Bearer page-token", "content-type": "application/json" }),
      nextUrl: { host: "matrix.test", pathname: "/api/bridge/capabilities", protocol: "https:", search: "" },
    };
    await proxy(request as Parameters<typeof proxy>[0], {} as Parameters<typeof proxy>[1]);
    if (userId === "owner") {
      expect(rewrite).toHaveBeenCalledOnce();
      const [url, init] = rewrite.mock.calls[0];
      expect(url.toString()).toBe("http://selected-computer.internal:4000/api/bridge/capabilities");
      expect(init.request.headers.get("authorization")).toBe("Bearer trusted-owner-gateway-token");
      expect(init.request.headers.get("content-type")).toBe("application/json");
    } else expect(rewrite).not.toHaveBeenCalled();
  });

  it("uses the uncapped streaming route when opening PDFs in the browser", () => {
    const source = readFileSync("shell/src/components/preview-window/PreviewTab.tsx", "utf8");

    expect(source).toContain("href={fileMediaUrl(path)}");
    expect(source).not.toContain("href={fileBlobUrl(path)}");
  });
});
