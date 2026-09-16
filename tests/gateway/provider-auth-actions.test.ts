import { describe, expect, it } from "vitest";
import { createCodingAgentProviderRegistry } from "../../packages/gateway/src/coding-agents/provider-registry";
import type { AgentProviderSummary } from "@matrix-os/contracts";
import type { CodingAgentProviderAdapter } from "../../packages/gateway/src/coding-agents/thread-store";

async function summary(id: "claude" | "codex" | "opencode" | "pi", authStatus: AgentProviderSummary["authStatus"], installed = true) {
  const provider: CodingAgentProviderAdapter = {
    providerId: id,
    getSummary: () => ({
      id, kind: id, displayName: id === "claude" ? "Claude" : id === "codex" ? "Codex" : id === "pi" ? "Pi" : "OpenCode",
      availability: authStatus === "authenticated" ? "available" : "auth_required",
      installStatus: installed ? "installed" : "missing", authStatus,
      supportedModes: ["default"], defaultMode: "default",
      setupActions: [
        { id: `${id}_install`, kind: "foreground_terminal", label: "Install", command: "install-command" },
        { id: `${id}_connect`, kind: "foreground_terminal", label: "Connect", command: "connect-command" },
      ],
    }),
    startThread: () => [],
  };
  const registry = createCodingAgentProviderRegistry({ providers: [provider] });
  return (await registry.listProviders({ userId: "owner", source: "jwt" }))[0]!;
}

describe("provider authentication actions", () => {
  it.each([
    ["claude", "Claude", "claude auth logout"],
    ["codex", "Codex", "codex logout"],
    ["opencode", "OpenCode", "opencode auth logout"],
    ["pi", "Pi", "/logout"],
  ] as const)("replaces Connect with a visible Disconnect for authenticated %s", async (id, label, command) => {
    const result = await summary(id, "authenticated");
    expect(result.setupActions).toEqual([expect.objectContaining({
      id: `${id}_disconnect`, label: `Disconnect ${label}`, kind: "foreground_terminal",
      command: expect.stringContaining(command),
    })]);
    if (id === "pi") {
      expect(result.setupActions[0]).toMatchObject({ command: expect.not.stringContaining("pi /logout") });
    }
  });
  it.each(["missing", "expired", "unknown"] as const)("keeps Connect when auth is %s", async (auth) => {
    expect((await summary("claude", auth)).setupActions.map((a) => a.id)).toEqual(["claude_connect"]);
  });
  it("retains install and connect while the CLI is missing", async () => {
    expect((await summary("claude", "missing", false)).setupActions.map((a) => a.id))
      .toEqual(["claude_install", "claude_connect"]);
  });
});
