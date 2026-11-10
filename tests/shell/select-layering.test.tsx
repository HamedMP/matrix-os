// @vitest-environment jsdom
import React from "react";
import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../packages/ui/src/Select";
import { SHELL_Z_INDEX } from "../../shell/src/lib/shell-layering";

it("opens shared select menus above the Settings window so filters stay clickable", () => {
  Element.prototype.scrollIntoView ??= () => {};
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  render(
    <Select open value="a">
      <SelectTrigger aria-label="Coding agent"><SelectValue /></SelectTrigger>
      <SelectContent position="popper"><SelectItem value="a">All agents</SelectItem></SelectContent>
    </Select>,
  );
  const menu = document.querySelector<HTMLElement>('[data-slot="select-content"]');
  expect(menu).not.toBeNull();
  const layer = Number(menu!.style.zIndex);
  expect(layer).toBeGreaterThan(SHELL_Z_INDEX.settings);
  expect(layer).toBeGreaterThan(SHELL_Z_INDEX.hardGate);
  expect(layer).toBe(SHELL_Z_INDEX.popover);
});

it("closes only the open menu on Escape, not the window that hosts it", () => {
  Element.prototype.scrollIntoView ??= () => {};
  const hostEscape = vi.fn();
  const onOpenChange = vi.fn();
  window.addEventListener("keydown", hostEscape);
  render(
    <Select open value="a" onOpenChange={onOpenChange}>
      <SelectTrigger aria-label="Date range"><SelectValue /></SelectTrigger>
      <SelectContent position="popper"><SelectItem value="a">Last year</SelectItem></SelectContent>
    </Select>,
  );
  const menu = document.querySelector<HTMLElement>('[data-slot="select-content"]')!;
  menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  window.removeEventListener("keydown", hostEscape);
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(hostEscape).not.toHaveBeenCalled();
});
