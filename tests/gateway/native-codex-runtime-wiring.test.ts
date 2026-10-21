import { describe, expect, it, vi, beforeEach } from "vitest";
import type { CodexExecutionAdmissionOptions } from "../../packages/gateway/src/coding-agents/codex-execution-admission.js";
const mocks = vi.hoisted(() => ({
  reader: vi.fn(), createReader: vi.fn(), createAdmission: vi.fn(),
  admission: { validateLaunch: vi.fn(), releaseStoppedSession: vi.fn() },
}));
vi.mock("../../packages/gateway/src/ai-providers/codex-native-account-metadata.js", () => ({
  createCodexNativeAccountMetadataReader: mocks.createReader,
}));
vi.mock("../../packages/gateway/src/coding-agents/codex-execution-admission.js", () => ({
  createCodexExecutionAdmission: mocks.createAdmission,
}));
import { createNativeCodexRuntime } from "../../packages/gateway/src/server/native-codex-runtime.js";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.createReader.mockReturnValue(mocks.reader);
  mocks.createAdmission.mockReturnValue(mocks.admission);
});
function fixture() {
  const guard = { assertReadable: vi.fn().mockResolvedValue(undefined) };
  const getSettings = vi.fn();
  const getRuntime = vi.fn();
  const runtime = createNativeCodexRuntime({ homePath: "/fixture/home", executable: "/fixture/codex",
    ownerIds: ["owner"], profileGuard: guard, getSettings, getRuntime,
    environment: () => ({ HOME: "/fixture/home", CODEX_HOME: "/fixture/home/.codex" }),
  });
  const admissionOptions = mocks.createAdmission.mock.calls[0]![0] as CodexExecutionAdmissionOptions;
  return { runtime, guard, getSettings, getRuntime, admissionOptions };
}
describe("native Codex runtime wiring", () => {
  it("guards both sides of metadata observation and shares one owner-scoped reader", async () => {
    const { runtime, guard } = fixture();
    const observation = { accountLabel: "fixture" };
    mocks.reader.mockResolvedValue(observation);
    expect(await runtime.readAccount()).toBe(observation);
    expect(await runtime.readAccount()).toBe(observation);
    expect(mocks.createReader).toHaveBeenCalledTimes(1);
    expect(mocks.createReader).toHaveBeenCalledWith({ executable: "/fixture/codex", cwd: "/fixture/home",
      environment: { HOME: "/fixture/home", CODEX_HOME: "/fixture/home/.codex" } });
    expect(guard.assertReadable).toHaveBeenCalledTimes(4);
    expect(guard.assertReadable.mock.invocationCallOrder[0]).toBeLessThan(mocks.reader.mock.invocationCallOrder[0]!);
    expect(guard.assertReadable.mock.invocationCallOrder[1]).toBeGreaterThan(mocks.reader.mock.invocationCallOrder[0]!);
  });
  it("forwards forced-fresh completion reads without changing ordinary observation", async () => {
    const { runtime, guard } = fixture();
    mocks.reader.mockResolvedValue(null);
    await runtime.readAccount();
    await runtime.readAccount({ purpose: "native_completion" });
    expect(mocks.reader).toHaveBeenNthCalledWith(1, undefined);
    expect(mocks.reader).toHaveBeenNthCalledWith(2, { purpose: "native_completion" });
    expect(mocks.createReader).toHaveBeenCalledTimes(1);
    expect(guard.assertReadable).toHaveBeenCalledTimes(4);
  });
  it("discards an observation when the profile becomes unavailable", async () => {
    const { runtime, guard } = fixture();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      mocks.reader.mockResolvedValue({ accountLabel: "fixture" });
      guard.assertReadable.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("private-detail"));
      expect(await runtime.readAccount()).toBeNull();
      expect(JSON.stringify(warning.mock.calls)).not.toContain("private-detail");
    } finally { warning.mockRestore(); }
  });
  it("fails closed until lazy dependencies exist and uses fresh settings and runtime", async () => {
    const { getSettings, getRuntime, admissionOptions } = fixture();
    expect(admissionOptions.isOwner("other")).toBe(false);
    expect(admissionOptions.isOwner("owner")).toBe(true);
    await expect(admissionOptions.getSnapshot()).rejects.toThrow("unavailable");
    await expect(admissionOptions.stopSession!("session")).rejects.toThrow("unavailable");
    const getSnapshot = vi.fn().mockResolvedValue({ revision: 2 });
    getSettings.mockReturnValue({ getSnapshot });
    expect(await admissionOptions.getSnapshot()).toEqual({ revision: 2 });
    expect(getSnapshot).toHaveBeenCalledWith({ includeNativeAccountMetadata: true, includeNativeAccountUsage: false });
    const stopSession = vi.fn().mockResolvedValue({ ok: false });
    getRuntime.mockReturnValue({ stopSession });
    await expect(admissionOptions.stopSession!("session")).rejects.toThrow("unavailable");
    stopSession.mockResolvedValue({ ok: true });
    await admissionOptions.stopSession!("session");
    expect(stopSession).toHaveBeenLastCalledWith("session");
  });
  it("forwards the private deletion receipt and binds launch to the owner profile", async () => {
    const { runtime } = fixture();
    const proof = {};
    await runtime.beforeProjectSessionRemove({ ownerId: "owner", sessionId: "session", proof });
    expect(mocks.admission.releaseStoppedSession).toHaveBeenCalledWith("owner", "session", proof);
    expect(await runtime.resolveSubscription("owner", "session")).toBeUndefined();
    mocks.admission.validateLaunch.mockResolvedValue({ expectedConsentRevision: 7 });
    expect(await runtime.resolveSubscription("owner", "session")).toEqual({ expectedConsentRevision: 7, codexHome: "/fixture/home/.codex" });
  });
});
