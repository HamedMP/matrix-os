import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRuntimeAppAiRoutes } from "../../packages/gateway/src/app-ai/runtime.js";
const mocks = vi.hoisted(() => ({
  principal: vi.fn(() => ({ userId: "owner" })),
  sources: vi.fn(async () => ({ selectedAccessSourceId: "owner_anthropic_key" })),
  launch: vi.fn(async () => ({ env: { ANTHROPIC_API_KEY: "test-only" } })),
  generate: vi.fn(async () => ({ text: "summary" })),
}));
vi.mock("../../packages/gateway/src/request-principal.js", () => ({ requireRequestPrincipal: mocks.principal }));
vi.mock("../../packages/gateway/src/kernel-credentials.js", () => ({ resolveKernelCredentialSources: mocks.sources, buildKernelCredentialLaunch: mocks.launch }));
vi.mock("@matrix-os/kernel", () => ({ generateAppText: mocks.generate, DEFAULT_KERNEL_MODEL: "claude-opus-5", DEFAULT_KERNEL_EFFORT: "high" }));
let homePath: string;
beforeEach(async () => {
  homePath = await mkdtemp(join(tmpdir(), "app-ai-test-"));
  await mkdir(join(homePath, "system"));
  vi.clearAllMocks();
  mocks.principal.mockReturnValue({ userId: "owner" });
  mocks.sources.mockResolvedValue({ selectedAccessSourceId: "owner_anthropic_key" });
});
afterEach(async () => { await rm(homePath, { recursive: true, force: true }); });
async function allow() {
  await writeFile(join(homePath, "system/app-ai.json"), JSON.stringify({ apps: ["brain"], model: "claude-sonnet-5" }));
}
function request(app = "brain") {
  return createRuntimeAppAiRoutes({ homePath, ownerIds: ["owner"] }).request("/", { method: "POST", body: JSON.stringify({ app, prompt: "notes" }) });
}
it("fails closed without an owner grant", async () => {
  expect((await request()).status).toBe(403);
  expect(mocks.launch).not.toHaveBeenCalled();
});
it("denies a different app and non-owner principal", async () => {
  await allow();
  expect((await request("other")).status).toBe(403);
  mocks.principal.mockReturnValue({ userId: "collaborator" });
  expect((await request()).status).toBe(403);
  expect(mocks.launch).not.toHaveBeenCalled();
});
it("resolves owner credentials server-side and only returns text", async () => {
  await allow();
  const response = await request();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ text: "summary" });
  expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-sonnet-5", prompt: "notes", env: { ANTHROPIC_API_KEY: "test-only" }, signal: expect.any(AbortSignal) }));
});
it("does not convert malformed policy into a grant", async () => {
  await writeFile(join(homePath, "system/app-ai.json"), "not json");
  expect((await request()).status).toBe(503);
  expect(mocks.generate).not.toHaveBeenCalled();
});
it("enforces the included model allowlist before leasing credentials", async () => {
  await writeFile(join(homePath, "system/app-ai.json"), JSON.stringify({ apps: ["brain"], model: "claude-opus-5" }));
  mocks.sources.mockResolvedValue({ selectedAccessSourceId: "matrix_included" });
  expect((await request()).status).toBe(503);
  expect(mocks.launch).not.toHaveBeenCalled();
});
