import { GatewayClient } from "../lib/gateway-client";
import { jsonResponse } from "./mobile-shell-test-utils";

beforeEach(() => { global.fetch = jest.fn(); });
describe("GitHub developer access client", () => {
    const fullStatus = {
      installed: true,
      authenticated: true,
      user: "octocat",
      gitProtocol: "ssh",
      sshStatus: "verified",
      commitIdentity: { status: "ready", label: "Octo Cat <1+octocat@users.noreply.github.com>" },
      ready: true,
      errorCode: null,
    };

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it("accepts the additive status only when every required field has a safe shape", async () => {
      const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(jsonResponse(fullStatus));
      const client = new GatewayClient("http://localhost:4000", "token");

      await expect(client.getGithubDeveloperStatus()).resolves.toEqual({ ok: true, status: fullStatus });
      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:4000/api/github/status",
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer token" }),
          signal: expect.any(Object),
        }),
      );
    });

    it.each([
      { installed: true, authenticated: true, user: "legacy" },
      { ...fullStatus, sshStatus: "maybe" },
      { ...fullStatus, commitIdentity: { status: "ready", label: "x".repeat(526) } },
    ])("fails closed for legacy, partial, or malformed status payloads", async (payload) => {
      jest.spyOn(global, "fetch").mockResolvedValue(jsonResponse(payload));
      const client = new GatewayClient("http://localhost:4000", "token");

      await expect(client.getGithubDeveloperStatus()).resolves.toEqual({
        ok: false,
        error: "GitHub developer access unavailable",
      });
    });

    it("does not trust a true ready flag when any readiness prerequisite is incomplete", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue(jsonResponse({
        ...fullStatus,
        sshStatus: "setup_required",
      }));
      const client = new GatewayClient("http://localhost:4000", "token");

      await expect(client.getGithubDeveloperStatus()).resolves.toEqual({
        ok: true,
        status: { ...fullStatus, sshStatus: "setup_required", ready: false },
      });
    });

    it("accepts shared-contract identity labels longer than 256 characters", async () => {
      const status = { ...fullStatus, commitIdentity: { status: "ready", label: "x".repeat(300) } };
      jest.spyOn(global, "fetch").mockResolvedValue(jsonResponse(status));
      await expect(new GatewayClient("http://localhost:4000").getGithubDeveloperStatus()).resolves.toEqual({ ok: true, status });
    });

    it.each(["http://localhost:4000", "https://app.matrix-os.com/vm/my-computer"])("uses selected-computer device setup routes at %s", async (base) => {
      const id = "bda87d44-cbe8-4bc0-b681-1e07ecfa3d47";
      const operation = { id, state: "awaiting_authorization", deviceCode: "ABCD-1234" };
      const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(jsonResponse(operation));
      const client = new GatewayClient(base, "token");
      await expect(client.startGithubDeveloperSetup()).resolves.toEqual(operation);
      await expect(client.getGithubDeveloperSetup(id)).resolves.toEqual(operation);
      await expect(client.cancelGithubDeveloperSetup(id)).resolves.toEqual(operation);
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        `${base}/api/github/setup`, `${base}/api/github/setup/${id}`, `${base}/api/github/setup/${id}/cancel`,
      ]);
      for (const [, init] of fetchMock.mock.calls) {
        expect(init).toEqual(expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer token" }), signal: expect.any(Object) }));
      }
      expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({ method: "POST", body: "{}" }));
      expect(fetchMock.mock.calls[2][1]).toEqual(expect.objectContaining({ method: "POST", body: "{}" }));
    });

    it("rejects invalid operation IDs without making requests", async () => {
      const fetchMock = jest.spyOn(global, "fetch");
      const client = new GatewayClient("http://localhost:4000");
      await expect(client.getGithubDeveloperSetup("../unsafe")).rejects.toThrow("GitHub setup unavailable");
      await expect(client.cancelGithubDeveloperSetup("../unsafe")).rejects.toThrow("GitHub setup unavailable");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      { id: "invalid", state: "starting" },
      { id: "bda87d44-cbe8-4bc0-b681-1e07ecfa3d47", state: "awaiting_authorization", deviceCode: "unsafe" },
    ])("rejects malformed setup responses", async (body) => {
      jest.spyOn(global, "fetch").mockResolvedValue(jsonResponse(body));
      await expect(new GatewayClient("http://localhost:4000").startGithubDeveloperSetup()).rejects.toThrow("GitHub setup unavailable");
    });

    it("rejects a poll for a different operation", async () => {
      const id = "bda87d44-cbe8-4bc0-b681-1e07ecfa3d47";
      jest.spyOn(global, "fetch").mockResolvedValue(jsonResponse({ id: "ada87d44-cbe8-4bc0-b681-1e07ecfa3d47", state: "succeeded" }));
      await expect(new GatewayClient("http://localhost:4000").getGithubDeveloperSetup(id)).rejects.toThrow("GitHub setup unavailable");
    });

    it.each([403, 404, 500])("reports safe setup recovery for HTTP %s", async (status) => {
      jest.spyOn(global, "fetch").mockResolvedValue(jsonResponse("private provider failure", { status }));
      await expect(new GatewayClient("http://localhost:4000").startGithubDeveloperSetup()).rejects.toThrow("GitHub setup unavailable");
    });
  });
