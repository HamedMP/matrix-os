import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { generateSideChatText } from "../../packages/gateway/src/chat/side-chat-generation.js";

const complete = vi.hoisted(() => vi.fn(async () => ({ text: "Funded answer" })));
vi.mock("../../packages/gateway/src/app-ai/api-completion.js", () => ({ generateApiAppText: complete }));
let home: string | undefined;
afterEach(async () => { if (home) await rm(home, { recursive: true, force: true }); home = undefined; complete.mockClear(); });

it("routes Matrix included side chat through read-only API completion", async () => {
  home = await mkdtemp(join(tmpdir(), "side-chat-generation-"));
  const result = await generateSideChatText({ homePath: home }, "Summarize the main chat", AbortSignal.timeout(10_000));
  expect(result).toEqual({ text: "Funded answer" });
  expect(complete).toHaveBeenCalledWith(expect.objectContaining({
    prompt: "Summarize the main chat",
    route: expect.objectContaining({ accessSourceId: "matrix_included", modelId: "claude-sonnet-5" }),
  }));
});
