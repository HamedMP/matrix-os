// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RichContent } from "../../shell/src/components/ui-blocks";

afterEach(cleanup);

it("routes a local Markdown image to File Preview without mounting a broken image", () => {
  const openFile = vi.fn();
  render(<RichContent openFile={openFile}>{"![Generated whale](data/chat-artifacts/whale.png)"}</RichContent>);
  expect(screen.queryByRole("img", { name: "Generated whale" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Preview image Generated whale" }));
  expect(openFile).toHaveBeenCalledWith("data/chat-artifacts/whale.png");
});

it("opens an inline workspace file in the inspector while leaving fenced code intact", () => {
  const openFile=vi.fn();
  render(<RichContent openFile={openFile}>{'Changed `desktop/src/nav/MobileNav.tsx`.\n\n```txt\ndesktop/src/nav/MobileNav.tsx\n```'}</RichContent>);
  const files=screen.getAllByRole('button',{name:'Open MobileNav.tsx'});
  expect(files).toHaveLength(1);
  fireEvent.click(files[0]);
  expect(openFile).toHaveBeenCalledWith('desktop/src/nav/MobileNav.tsx');
  expect(document.querySelector('pre code')?.textContent).toContain('desktop/src/nav/MobileNav.tsx');
});
