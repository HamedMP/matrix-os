import { afterEach, describe, expect, it, vi } from "vitest";
const { createHost } = vi.hoisted(() => ({ createHost: vi.fn(async () => ({ available: true })) }));
vi.mock("../../packages/gateway/src/scope-runtime-host/index.js", () => ({ createScopeRuntimeHost: createHost }));
import { startScopeRuntimeHost } from "../../packages/gateway/src/startup/scope-runtime-host.js";
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe("scope-runtime startup namespace wiring", () => {
  it.each([undefined, "eng432-stage2"])("forwards both resolved sockets for %s", async (namespace) => {
    vi.stubEnv("MATRIX_SCOPE_RUNTIME_NAMESPACE", namespace);
    vi.stubEnv("MATRIX_SCOPE_RUNTIME_APP_ROOT", namespace ? `/var/lib/matrix-devstack/${namespace}/app` : undefined);
    const homePath = namespace ? `/var/lib/matrix-devstack/${namespace}/home` : "/home/matrix/home";
    vi.stubEnv("MATRIX_HOME", homePath);
    const onFailure = vi.fn();
    await startScopeRuntimeHost({ homePath, onFailure });
    const root = namespace ? `/run/matrix-devstack/${namespace}/scope-runtime` : "/run/matrix-scope-runtime";
    expect(createHost).toHaveBeenCalledWith(expect.objectContaining({ homePath, supervisorSocket: `${root}/supervisor.sock`, brokerSocket: `${root}/broker.sock` }));
    expect(onFailure).not.toHaveBeenCalled();
  });
  it("refuses invalid namespace/home before opening a supervisor or broker connection", async () => {
    vi.stubEnv("MATRIX_SCOPE_RUNTIME_NAMESPACE", "eng432-stage2");
    vi.stubEnv("MATRIX_SCOPE_RUNTIME_APP_ROOT", "/opt/matrix/app");
    const onFailure = vi.fn();
    await expect(startScopeRuntimeHost({ homePath: "/home/matrix/home", onFailure })).rejects.toThrow();
    expect(createHost).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });
  it("propagates a namespaced constructor failure rather than exposing an absent host", async () => {
    const namespace = "eng432-stage2";
    vi.stubEnv("MATRIX_SCOPE_RUNTIME_NAMESPACE", namespace);
    vi.stubEnv("MATRIX_SCOPE_RUNTIME_APP_ROOT", `/var/lib/matrix-devstack/${namespace}/app`);
    vi.stubEnv("MATRIX_HOME", `/var/lib/matrix-devstack/${namespace}/home`);
    createHost.mockRejectedValueOnce(new Error("host failed"));
    const onFailure = vi.fn();
    await expect(startScopeRuntimeHost({ homePath: `/var/lib/matrix-devstack/${namespace}/home`, onFailure })).rejects.toThrow("host failed");
    expect(onFailure).toHaveBeenCalledOnce();
  });
});
