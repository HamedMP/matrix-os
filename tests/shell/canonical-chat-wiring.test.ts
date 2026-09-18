import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Canvas and web desktop canonical Chat wiring", () => {
  it("provides one canonical Chat state to every shared shell renderer", () => {
    const shellHome = readFileSync(join(process.cwd(), "shell/src/components/ShellHome.tsx"), "utf8");
    const canonicalState = readFileSync(join(process.cwd(), "shell/src/hooks/useCanonicalChatState.ts"), "utf8");
    const providerState = readFileSync(join(process.cwd(), "shell/src/components/chat-app-provider-setup.tsx"), "utf8");
    const desktop = readFileSync(join(process.cwd(), "shell/src/components/Desktop.tsx"), "utf8");
    const mobile = readFileSync(join(process.cwd(), "shell/src/components/mobile/MobileShell.tsx"), "utf8");
    const userButton = readFileSync(join(process.cwd(), "shell/src/components/UserButton.tsx"), "utf8");

    expect(shellHome).toContain("const chatCollaborationView = terminalCollaborationView ? undefined : initialCollaborationView");
    expect(shellHome).toContain("useCanonicalChatState({ initialDraft: recipePrompt, initialCollaborationView: chatCollaborationView })");
    expect(shellHome).not.toContain("useChatState()");
    expect(mobile).toContain("collaborationView={chat.collaborationView}");
    expect(mobile).toContain("onOpenSharedChat={chat.openSharedChat}");
    expect(userButton).toContain("showSharedWithMe={!isMobile}");
    expect(canonicalState).toContain("client.admitTurn(");
    expect(canonicalState).toContain("client.uploadAttachment(");
    expect(canonicalState).toContain("activeChatId && detailRef.current?.record.chat.id !== activeChatId");
    expect(canonicalState).not.toContain('type: "message"');
    expect(providerState).toContain("/api/chat-providers?refresh=true");
    expect(providerState).not.toContain("/api/ai/providers");
    expect(providerState).toContain("onSetupAction(instance, action)");
    expect(desktop).toContain("OPEN_PROVIDER_SETTINGS_EVENT");
    expect(desktop).toContain("OPEN_PROVIDER_TERMINAL_EVENT");
  });
});
