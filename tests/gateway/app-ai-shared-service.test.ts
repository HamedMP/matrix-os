import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRuntimeAppAiService } from "../../packages/gateway/src/app-ai/runtime.js";
const mocks = vi.hoisted(() => ({
  sources: vi.fn(async () => ({ selectedAccessSourceId: "owner_anthropic_key" })),
  launch: vi.fn(async () => ({ env: { ANTHROPIC_API_KEY: "fixture-only" } })),
  generate: vi.fn(async () => ({ text: "summary" })),
}));
vi.mock("../../packages/gateway/src/kernel-credentials.js", () => ({ resolveKernelCredentialSources: mocks.sources, buildKernelCredentialLaunch: mocks.launch }));
vi.mock("@matrix-os/kernel", () => ({ generateAppText: mocks.generate, DEFAULT_KERNEL_MODEL: "claude-opus-5", DEFAULT_KERNEL_EFFORT: "high" }));
let homePath: string;
beforeEach(async () => {
  homePath = await mkdtemp(join(tmpdir(), "app-ai-shared-"));
  await mkdir(join(homePath, "system"));
  await writeFile(join(homePath, "system/app-ai.json"), JSON.stringify({ apps: ["briefing"], model: "claude-sonnet-5" }));
  vi.clearAllMocks();
});
afterEach(async () => { await rm(homePath, { recursive: true, force: true }); });
const request = { app: "briefing", prompt: "evidence" };
it("denies a scheduled non-owner before obtaining credentials", async () => {
  const service = createRuntimeAppAiService({ homePath, ownerIds: ["owner"] });
  await expect(service.generate("collaborator", request, new AbortController().signal)).rejects.toThrow();
  expect(mocks.launch).not.toHaveBeenCalled();
});
it("rechecks a revoked grant after resolving credentials", async () => {
  const service = createRuntimeAppAiService({ homePath, ownerIds: ["owner"] });
  mocks.launch.mockImplementationOnce(async () => {
    await writeFile(join(homePath, "system/app-ai.json"), JSON.stringify({ apps: [], model: "claude-sonnet-5" }));
    return { env: { ANTHROPIC_API_KEY: "fixture-only" } };
  });
  await expect(service.generate("owner", request, new AbortController().signal)).rejects.toThrow();
  expect(mocks.generate).not.toHaveBeenCalled();
});
it("shares concurrency admission across background and interactive calls", async () => {
  const service = createRuntimeAppAiService({ homePath, ownerIds: ["owner"] });
  const releases: Array<() => void> = [];
  mocks.generate.mockImplementation(() => new Promise(resolve => releases.push(() => resolve({ text: "done" }))));
  const first = service.generate("owner", request, new AbortController().signal);
  const second = service.generate("owner", request, new AbortController().signal);
  await vi.waitFor(() => expect(releases).toHaveLength(2));
  await expect(service.generate("owner", request, new AbortController().signal)).rejects.toThrow();
  releases.forEach(release => release());
  await Promise.all([first, second]);
  mocks.generate.mockResolvedValue({ text: "next" });
  expect(await service.generate("owner", request, new AbortController().signal)).toEqual({ text: "next" });
});

it("rejects changed model policy after an in-flight generation", async () => {
  const service = createRuntimeAppAiService({ homePath, ownerIds: ["owner"] });
  mocks.generate.mockImplementationOnce(async () => {
    await writeFile(join(homePath, "system/app-ai.json"), JSON.stringify({ apps: ["briefing"], model: "claude-opus-5" }));
    return { text: "stale model result" };
  });
  await expect(service.generate("owner", request, new AbortController().signal)).rejects.toThrow();
});

it("uses explicitly selected Matrix AI without launching the owner SDK", async () => {
  await writeFile(join(homePath, "system/app-ai.json"), JSON.stringify({ apps: ["briefing"], model: "@cf/zai-org/glm-5.3-flash" }));
  const getCredential = vi.fn(async () => ({ token: "fixture-lease", relayBaseUrl: "https://relay.example.test", requestClass: "background" }));
  const fetchImpl = vi.fn(async () => Response.json({ choices: [{ message: { role: "assistant", content: "managed summary" }, finish_reason: "stop" }] }));
  const service = createRuntimeAppAiService({ homePath, ownerIds: ["owner"], fundedCredentialProvider: { enabled: true, getCredential } as never, fetchImpl });
  expect(await service.generate("owner", request, new AbortController().signal, "background")).toEqual({ text: "managed summary" });
  expect(mocks.sources).not.toHaveBeenCalled();
  expect(mocks.launch).not.toHaveBeenCalled();
  expect(mocks.generate).not.toHaveBeenCalled();
  expect(getCredential).toHaveBeenCalledWith(expect.objectContaining({ requestClass: "background" }));
});

it("defaults manual Matrix AI calls to interactive and rejects changed policy before publication", async () => {
  await writeFile(join(homePath, "system/app-ai.json"), JSON.stringify({ apps: ["briefing"], model: "@cf/zai-org/glm-5.3-flash" }));
  const getCredential = vi.fn(async () => ({ token: "fixture-lease", relayBaseUrl: "https://relay.example.test", requestClass: "interactive" }));
  const fetchImpl = vi.fn(async () => {
    await writeFile(join(homePath, "system/app-ai.json"), JSON.stringify({ apps: ["briefing"], model: "claude-sonnet-5" }));
    return Response.json({ choices: [{ message: { role: "assistant", content: "stale model summary" }, finish_reason: "stop" }] });
  });
  const service = createRuntimeAppAiService({ homePath, ownerIds: ["owner"], fundedCredentialProvider: { enabled: true, getCredential } as never, fetchImpl });
  await expect(service.generate("owner", request, new AbortController().signal)).rejects.toThrow(/^App AI is unavailable$/);
  expect(getCredential).toHaveBeenCalledWith(expect.objectContaining({ requestClass: "interactive" }));
  expect(mocks.launch).not.toHaveBeenCalled();
});
