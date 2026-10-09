import { expect, it, vi } from "vitest";
import { Hono } from "hono";
const state = vi.hoisted(() => ({
  integration: vi.fn(), ai: vi.fn(), piClose: vi.fn(async () => {}), hermesClose: vi.fn(async () => {}),
}));
vi.mock("../../packages/gateway/src/app-capabilities/routes.js", () => ({ createAppCapabilityRoutes: (options: unknown) => { state.integration(options); return new Hono().get("/", c => c.json({ ready: true })); } }));
vi.mock("../../packages/gateway/src/app-ai/runtime.js", () => ({ isAppAiAllowed: async () => false, createRuntimeAppAiRoutes: (options: unknown) => { state.ai(options); return new Hono().get("/", c => c.json({ ready: true })); } }));
vi.mock("../../packages/gateway/src/app-ai/pi-sdk-completion.js", () => ({ createPiSdkAppCompletion: () => ({ close: state.piClose }) }));
vi.mock("../../packages/gateway/src/app-ai/hermes-completion.js", () => ({ createHermesAppCompletion: () => ({ close: state.hermesClose }) }));
import { registerAppIntegrationCapabilities, registerAppAiCapabilities, createAppAiSubscriptionObservation } from "../../packages/gateway/src/server/app-capabilities.js";

it("mounts app integration and AI routes with injected owner dependencies and drains both executors", async () => {
  const app = new Hono();
  registerAppIntegrationCapabilities(app, { homePath: "/tmp/owner", ownerIds: ["owner"], integrationTransport: null });
  const runtime = registerAppAiCapabilities(app, { homePath: "/tmp/owner", ownerIds: ["owner"], hermesRuntimeSource: {} as never });
  expect((await app.request("/api/bridge/capabilities")).status).toBe(200);
  expect((await app.request("/api/bridge/ai")).status).toBe(200);
  expect(state.integration).toHaveBeenCalledWith(expect.objectContaining({ ownerIds: ["owner"], integrations: null }));
  expect(state.ai).toHaveBeenCalledWith(expect.objectContaining({ ownerIds: ["owner"], piSdkCompletion: expect.any(Object), hermesCompletion: expect.any(Object) }));
  state.piClose.mockRejectedValueOnce(new Error("synthetic drain failure"));
  await expect(runtime.close()).rejects.toThrow();
  expect(state.piClose).toHaveBeenCalledOnce();
  expect(state.hermesClose).toHaveBeenCalledOnce();
});
it("observes the exact live subscription owner and denies aborted observation", async () => {
  const observe = vi.fn(async () => undefined);
  const source = vi.fn(() => ({ ownerId: "owner", authority: { observe } }));
  const reader = createAppAiSubscriptionObservation(source as never);
  await reader(AbortSignal.timeout(1000));
  expect(observe).toHaveBeenCalledWith("owner");
  const controller = new AbortController(); controller.abort();
  await expect(reader(controller.signal)).rejects.toThrow();
  expect(observe).toHaveBeenCalledOnce();
});
