// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkRailHeader, WorkRailSearchControls } from "@desktop/renderer/src/features/work/work-rail/WorkRailHeader";
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
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

it.each([['MacIntel', '⌘N'], ['Win32', 'Ctrl+N'], ['Linux x86_64', 'Ctrl+N']])('shows the actual New Chat accelerator on %s', (platform, label) => {
 vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
 render(<WorkRailHeader shortcutAvailable onNewChat={vi.fn()} onCollapse={vi.fn()} showCollapseControl={false} />);
 expect(screen.getByRole('button', {name:'New chat'}).querySelector('kbd')?.textContent).toBe(label);
});
it('keeps New Chat clickable without advertising an unavailable shortcut', () => {
 const create=vi.fn();
 render(<WorkRailHeader shortcutAvailable={false} onNewChat={create} onCollapse={vi.fn()} showCollapseControl={false} />);
 const button=screen.getByRole('button', {name:'New chat'});
 expect(button.querySelector('kbd')).toBeNull();
 fireEvent.click(button);
 expect(create).toHaveBeenCalledOnce();
});
