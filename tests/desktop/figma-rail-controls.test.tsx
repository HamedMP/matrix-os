// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveShortcuts, type ShortcutPlatform } from "@matrix-os/contracts/keyboard-shortcuts";
import { WorkRailHeader, WorkRailSearchControls } from "@desktop/renderer/src/features/work/work-rail/WorkRailHeader";
import { useShortcuts } from "@desktop/renderer/src/stores/shortcuts";
function loadBindings(platform: ShortcutPlatform, overrides: Record<string, string[]> = {}) {
 const document = { version: 1 as const, overrides };
 useShortcuts.setState({ snapshot: { platform, overrides: document, effective: resolveShortcuts(document, platform) } });
}
beforeEach(() => { loadBindings("mac"); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); useShortcuts.setState({ snapshot: null }); });
it("names New chat independently of its shortcut and preserves rail actions", () => {
 const create = vi.fn(), collapse = vi.fn(), search = vi.fn();
 vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
 render(<><WorkRailHeader shortcutAvailable onNewChat={create} onCollapse={collapse} showCollapseControl /><WorkRailSearchControls onSearch={search} /></>);
 const button = screen.getByRole("button", { name: "New chat", exact: true });
 expect(button.querySelector("kbd")?.textContent).toBe("⌘N");
 fireEvent.click(button);
 fireEvent.click(screen.getByRole("button", { name: "Hide Chat navigation" }));
 fireEvent.click(screen.getByRole("button", { name: "Search chats" }));
 expect(create).toHaveBeenCalledOnce(); expect(collapse).toHaveBeenCalledOnce(); expect(search).toHaveBeenCalledOnce();
 expect(screen.queryByRole("button", { name: "Sort chats" })).toBeNull();
 expect(screen.getByRole("button", { name: "Search chats" }).querySelector("kbd")?.textContent).toMatch(/⌘K|Ctrl\+K/);
});

it.each([['mac', '⌘N'], ['other', 'Ctrl+N']] as const)('shows the actual New Chat accelerator on %s', (platform, label) => {
 loadBindings(platform);
 render(<WorkRailHeader shortcutAvailable onNewChat={vi.fn()} onCollapse={vi.fn()} showCollapseControl={false} />);
 expect(screen.getByRole('button', {name:'New chat'}).querySelector('kbd')?.textContent).toBe(label);
});
it('follows a rebinding and hides the hint when the action is unbound or bindings are not loaded', () => {
 loadBindings('mac', { 'tabs.new-context': ['Cmd+Shift+N'] });
 const view = render(<WorkRailHeader shortcutAvailable onNewChat={vi.fn()} onCollapse={vi.fn()} showCollapseControl={false} />);
 expect(screen.getByRole('button', {name:'New chat'}).querySelector('kbd')?.textContent).toBe('⌘⇧N');
 act(() => loadBindings('mac', { 'tabs.new-context': [] }));
 expect(screen.getByRole('button', {name:'New chat'}).querySelector('kbd')).toBeNull();
 act(() => useShortcuts.setState({ snapshot: null }));
 expect(screen.getByRole('button', {name:'New chat'}).querySelector('kbd')).toBeNull();
 view.unmount();
});
it('keeps New Chat clickable without advertising an unavailable shortcut', () => {
 const create=vi.fn();
 render(<WorkRailHeader shortcutAvailable={false} onNewChat={create} onCollapse={vi.fn()} showCollapseControl={false} />);
 const button=screen.getByRole('button', {name:'New chat'});
 expect(button.querySelector('kbd')).toBeNull();
 fireEvent.click(button);
 expect(create).toHaveBeenCalledOnce();
});
