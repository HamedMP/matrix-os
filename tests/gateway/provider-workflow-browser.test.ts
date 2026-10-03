import { expect, it, vi } from "vitest";
import { createClaudeSettingsLogin, extractClaudeAuthorizationUrl } from "../../packages/gateway/src/ai-providers/provider-workflow-browser.js";
it("accepts only exact official browser authorization origins and paths", () => {
  expect(extractClaudeAuthorizationUrl("Visit https://claude.com/cai/oauth/authorize?state=fixture&code_challenge=test")).toBe("https://claude.com/cai/oauth/authorize?state=fixture&code_challenge=test");
  for (const url of ["https://evil.example/cai/oauth/authorize", "https://claude.com.evil.test/cai/oauth/authorize", "https://claude.com/profile?secret=x", "https://user:password@claude.com/cai/oauth/authorize", "https://claude.com:123/cai/oauth/authorize", "https://claude.com/cai/oauth/authorize#token"]) expect(extractClaudeAuthorizationUrl(url)).toBeNull();
});
it("holds a scoped browser login in Settings, submits code once, and enables only after native success", async () => {
  const publish = vi.fn(); const complete = vi.fn(); const release = vi.fn();
  const start = createClaudeSettingsLogin({ command: process.execPath, args: ["-e", 'console.log("https://claude.com/cai/oauth/authorize?state=fixture");process.stdin.once("data",()=>process.exit(0));'], cwd: process.cwd(), env: {}, acquire: async () => release });
  const running = await start({ publish, onSuccess: complete });
  await vi.waitFor(() => expect(publish).toHaveBeenCalledWith({ authorizationUrl: "https://claude.com/cai/oauth/authorize?state=fixture" }));
  expect(complete).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled();
  await running.submitCode!("fixture-authorization-code");
  await vi.waitFor(() => expect(publish).toHaveBeenCalledWith({ state: "succeeded", safeFailure: null }));
  expect(complete).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce();
  await expect(running.submitCode!("duplicate")).rejects.toThrow();
});
it("cancels and reaps before releasing the native lease and never enables", async () => {
  const complete = vi.fn(); const release = vi.fn();
  const start = createClaudeSettingsLogin({ command: process.execPath, args: ["-e", 'setInterval(()=>{},1000)'], cwd: process.cwd(), env: {}, acquire: async () => release });
  const running = await start({ publish: vi.fn(), onSuccess: complete });
  await running.cancel(); expect(release).toHaveBeenCalledOnce(); expect(complete).not.toHaveBeenCalled();
  await expect(running.submitCode!("late-code")).rejects.toThrow();
});
