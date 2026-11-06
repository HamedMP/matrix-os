import { expect, it, vi } from "vitest";
import { BotToolRequestSchema } from "@matrix-os/contracts";
import { createBotTools } from "../../packages/bot-runtime/src/tools.js";
import { createBotRecipeCatalog } from "../../packages/gateway/src/bots/recipe-catalog.js";

it("advertises bounded owner GitHub actions only after capability admission", async () => {
  const call = vi.fn(async () => ({ ok: true as const, content: [{ type: "text" as const, text: '{"ready":true}' }] }));
  const state = { waitingForPerson: false, effectUnknown: false };
  expect(createBotTools({ capabilities: [], broker: { tool: call } as never, state })).toEqual([]);
  const [tool] = createBotTools({ capabilities: ["github.developer"] as never, broker: { tool: call } as never, state });
  expect(tool?.name).toBe("github_developer");
  const signal = new AbortController().signal;
  await tool!.execute("github_1", { action: "status" }, signal);
  expect(call).toHaveBeenCalledWith(expect.objectContaining({ capability: "github.developer", args: { action: "status" } }), signal);
});

it("rejects arbitrary commands, secrets, remote hosts, unsafe branches and metadata paths", () => {
  for (const args of [
    { action: "exec", command: "gh auth token" },
    { action: "status", token: "secret" },
    { action: "clone", repository: "https://evil.test/repo", path: "repo" },
    { action: "clone", repository: "owner/repo", path: "../repo" },
    { action: "clone", repository: "owner/repo", path: "x/.git" },
    { action: "clone", repository: "owner/repo", path: "x/.matrix-github-staging" },
    { action: "branch", path: "repo", name: "main", expectedHead: "a".repeat(40) },
    { action: "commit", path: "repo", files: [".git/config"], message: "change", expectedHead: "a".repeat(40) },
    { action: "commit", path: "repo", files: Array.from({ length: 32 }, (_, i) => `${"a".repeat(120)}${i}.txt`), message: "change", expectedHead: "a".repeat(40) },
  ]) expect(BotToolRequestSchema.safeParse({ toolCallId: "github_bad", capability: "github.developer", args }).success).toBe(false);
});

it("keeps the existing default Bot recipe reference admitted to the owner GitHub tool", () => {
  const recipe = createBotRecipeCatalog().resolve({ recipeId: "matrix-bot", version: "2026-10-10.1" });
  expect(recipe.capabilities).toContain("github.developer");
});
