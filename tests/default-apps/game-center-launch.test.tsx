// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DefaultApp } from "../../home/apps/_shared/default-apps";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each([
  ["2048", "2048"], ["chess", "Chess"], ["solitaire", "Solitaire"],
  ["snake", "Snake"], ["minesweeper", "Minesweeper"],
  ["tetris", "Tetris"], ["backgammon", "Backgammon"],
])("opens %s through the host at its actual nested game path", (slug, title) => {
  const openApp = vi.fn();
  vi.stubGlobal("MatrixOS", { openApp });
  render(<DefaultApp id="games" />);
  fireEvent.click(screen.getByRole("button", { name: `Play ${title}` }));
  expect(openApp).toHaveBeenCalledWith(title, `apps/games/${slug}/index.html`);
});

it("disables game launch when the host bridge is unavailable", () => {
  vi.stubGlobal("MatrixOS", undefined);
  render(<DefaultApp id="games" />);
  for (const button of screen.getAllByRole("button", { name: /^Play / })) {
    expect((button as HTMLButtonElement).disabled).toBe(true);
  }
});

it("shows a recoverable message when the host cannot open a game", () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("MatrixOS", { openApp: () => { throw new Error("unavailable"); } });
  render(<DefaultApp id="games" />);
  fireEvent.click(screen.getByRole("button", { name: "Play Chess" }));
  expect(screen.getByRole("alert").textContent).toContain("This game could not be opened. Try again.");
});
