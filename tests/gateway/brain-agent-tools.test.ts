import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrainApiError, createBrainAgentTools, resolveBrainAgentOwnerId, type BrainProjectService, type BrainWhyResult,
} from "../../packages/gateway/src/brain/api/index.js";
import { BrainStoreError } from "../../packages/gateway/src/brain/index.js";

const RESULT: BrainWhyResult = {
  path: "src", match: "folder", detail: "brief", total: 0, totalCapped: false, items: [], nextCursor: null,
  source: { sourceId: "s".repeat(64), webBase: null, lastSync: null },
};

const serviceWith = (why: BrainProjectService["why"]): BrainProjectService => ({
  registerGitSource: vi.fn(), sync: vi.fn(), listReceipts: vi.fn(), why: vi.fn(why), extract: vi.fn(), listClaims: vi.fn(),
});

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("MATRIX_USER_ID", undefined);
  vi.stubEnv("MATRIX_AUTH_TOKEN", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("brain agent tools", () => {
  it("binds the owner a request without a JWT resolves to", () => {
    expect(resolveBrainAgentOwnerId()).toBe("default");
    vi.stubEnv("MATRIX_USER_ID", "owner_a");
    expect(resolveBrainAgentOwnerId()).toBe("owner_a");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubEnv("MATRIX_USER_ID", "bad owner/..");
    expect(resolveBrainAgentOwnerId()).toBeNull();
    expect(error).toHaveBeenCalledWith("[brain-agent] Owner unavailable:", "InvalidRequestPrincipalError");
  });

  it("lets an owner lookup failure that is not a principal error propagate", async () => {
    const principal = "../../packages/gateway/src/request-principal.js";
    vi.resetModules();
    vi.doMock(principal, async (original) => ({
      ...await original<object>(), getOptionalRequestPrincipal: () => { throw new TypeError("boom"); },
    }));
    const fresh = await import("../../packages/gateway/src/brain/api/agent-tools.js");
    expect(() => fresh.resolveBrainAgentOwnerId()).toThrow(TypeError);
    vi.doUnmock(principal);
  });

  it("registers no tool in production without a configured owner, or without a service", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MATRIX_AUTH_TOKEN", "token");
    expect(resolveBrainAgentOwnerId()).toBeNull();
    expect(createBrainAgentTools(serviceWith(async () => RESULT))).toBeUndefined();
    expect(createBrainAgentTools(null, "owner_a")).toBeUndefined();
  });

  it("calls the service as the bound owner and passes the result through as ok", async () => {
    const service = serviceWith(async () => RESULT);
    const result = await createBrainAgentTools(service, "owner_a")?.why({ project: "widgets", path: "src/", limit: 3, detail: "full" });
    expect(result).toEqual({ ...RESULT, status: "ok" });
    expect(service.why).toHaveBeenCalledWith("owner_a", "widgets", { path: "src/", limit: 3, cursor: null, detail: "full" });
  });

  it("maps service failures to fixed statuses and logs only error names", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const statusFor = async (thrown: Error) => (await createBrainAgentTools(
      serviceWith(async () => { throw thrown; }),
      "owner_a",
    )?.why({ project: "proj_a", path: "a.ts", cursor: "c" }))?.status;

    expect(await statusFor(new BrainApiError("project_not_found"))).toBe("not_found");
    expect(await statusFor(new BrainApiError("invalid_request"))).toBe("invalid");
    expect(await statusFor(new BrainStoreError("invalid"))).toBe("invalid");
    expect(error).not.toHaveBeenCalled();
    expect(await statusFor(new BrainApiError("brain_unavailable"))).toBe("unavailable");
    expect(await statusFor(new Error("relation brain_documents does not exist at /home/matrix"))).toBe("unavailable");
    expect(error).toHaveBeenLastCalledWith("[brain-agent] why failed:", "Error");
    const rejected = await createBrainAgentTools(serviceWith(() => Promise.reject("boom")), "owner_a")
      ?.why({ project: "proj_a", path: "a.ts" });
    expect([rejected?.status, error.mock.lastCall]).toEqual(["unavailable", ["[brain-agent] why failed:", "string"]]);
    expect(JSON.stringify(error.mock.calls)).not.toMatch(/relation|\/home\//);
  });
});
