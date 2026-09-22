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
