import { afterEach, describe, expect, it, vi } from "vitest";
const clerk = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@clerk/nextjs/server", () => ({ auth: clerk.auth }));
import { sharedWorkspaceAccess, sharedWorkerTarget } from "../../shell/src/app/workspace/access";

afterEach(() => vi.unstubAllEnvs());
describe("shared workspace server authorization", () => {
  it("fails closed when the explicit preview flag is absent", async () => {
    clerk.auth.mockResolvedValue({ userId: "owner", getToken: async () => "jwt" });
    expect(await sharedWorkspaceAccess(new Headers())).toEqual({ status: 404 });
  });
  it("requires a verified session even with the feature enabled", async () => {
    vi.stubEnv("MATRIX_SHARED_WORKSPACE_SPIKE", "1");
    clerk.auth.mockResolvedValue({ userId: null });
    expect(await sharedWorkspaceAccess(new Headers({ "x-platform-user-id": "owner" }))).toEqual({ status: 401 });
  });
  it("forwards the verified Clerk JWT rather than client owner headers", async () => {
    vi.stubEnv("MATRIX_SHARED_WORKSPACE_SPIKE", "1");
    clerk.auth.mockResolvedValue({ userId: "owner", getToken: async () => "verified-jwt" });
    expect(await sharedWorkspaceAccess(new Headers({ authorization: "Bearer forged" }))).toEqual({ status: 200, token: "verified-jwt" });
  });
  it("only accepts the isolated preview token with a fixed configured owner", async () => {
    vi.stubEnv("MATRIX_SHARED_WORKSPACE_SPIKE", "1");
    vi.stubEnv("MATRIX_SHARED_WORKSPACE_PREVIEW_TOKEN", "preview-secret");
    clerk.auth.mockResolvedValue({ userId: null });
    expect(await sharedWorkspaceAccess(new Headers({ authorization: "Bearer preview-secret" }))).toEqual({ status: 401 });
    vi.stubEnv("MATRIX_SHARED_WORKSPACE_PREVIEW_OWNER_ID", "test-owner");
    expect(await sharedWorkspaceAccess(new Headers({ authorization: "Bearer preview-secret", "x-owner-id": "attacker" }))).toEqual({ status: 200, token: "preview-secret" });
  });
  it("constructs URLs solely from trusted origin and bounded path segments", () => {
    vi.stubEnv("MATRIX_SHARED_WORKSPACE_ORIGIN", "https://preview.workers.dev");
    expect(sharedWorkerTarget(["api", "files"], "?path=notes").toString()).toBe("https://preview.workers.dev/api/files?path=notes");
    expect(() => sharedWorkerTarget(["..", "secret"], "")).toThrow();
    expect(() => sharedWorkerTarget(["https:", "evil.test"], "")).toThrow();
    vi.stubEnv("MATRIX_SHARED_WORKSPACE_ORIGIN", "http://evil.test");
    expect(() => sharedWorkerTarget(["api", "files"], "")).toThrow();
  });
});
