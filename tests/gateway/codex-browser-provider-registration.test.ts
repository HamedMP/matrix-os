import { expect, it, vi } from "vitest";
import { createWorkspaceCodingAgentProvider } from "../../packages/gateway/src/coding-agents/workspace-provider.js";
it("resolves browser control and event dependencies when registering Codex",()=>{
 const base={providerId:'codex',agent:'codex' as const,runtime:{startSession:vi.fn(),stopSession:vi.fn()},sharedBrowserEnabled:true};
 expect(()=>createWorkspaceCodingAgentProvider(base)).toThrow('Browser control unavailable');
 expect(()=>createWorkspaceCodingAgentProvider({...base,codexControl:{prepareBrowser:vi.fn()} as never,codexEvents:{} as never})).not.toThrow();
});
