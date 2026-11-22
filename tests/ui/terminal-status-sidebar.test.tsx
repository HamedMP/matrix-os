// @vitest-environment jsdom
import React, { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalStatusSidebar } from "../../packages/ui/src/terminal-status-sidebar/TerminalStatusSidebar";
import type { TerminalSidebarRow } from "../../packages/ui/src/terminal-status-sidebar/model";

afterEach(cleanup);

const NOW = Date.parse("2026-11-21T12:00:00Z");
const mac = { id: "local", name: "This Mac", remote: false };
const vps = { id: "primary", name: "Main Computer", remote: true };
const rows: TerminalSidebarRow[] = [
  { key: "a", name: "deploy", machine: vps, status: "blocked", statusAt: new Date(NOW - 5 * 60_000).toISOString() },
  { key: "b", name: "tests", machine: mac, status: "working" },
  { key: "c", name: "shell", machine: mac },
  { key: "d", name: "helper", machine: mac, status: "done", parentKey: "b" },
];

function Host({ onSelect = vi.fn(), rail = false }: { onSelect?: (key: string) => void; rail?: boolean }) {
  const [folded, setFolded] = useState<string[]>([]);
  return <TerminalStatusSidebar rows={rows} now={NOW} selectedKey="b" onSelect={onSelect} rail={rail}
    folded={folded} onToggleFold={(id) => setFolded((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])} />;
}

describe("terminal status sidebar", () => {
  it("shows Needs you first with the machine and time, and the selected terminal", () => {
    render(<Host />);
    const sections = screen.getAllByRole("region");
    expect(sections.map((section) => section.getAttribute("aria-label"))).toEqual(["Needs you", "Done", "Idle"]);
    const needsYou = within(sections[0]!);
    expect(needsYou.getByText("deploy")).toBeTruthy();
    expect(needsYou.getByText("Main Computer")).toBeTruthy();
    expect(needsYou.getByText("5m")).toBeTruthy();
    // "tests" is working but its sub-agent finished: the parent is listed under Done.
    expect(within(sections[1]!).getByRole("button", { name: /^tests/ }).getAttribute("aria-current")).toBe("true");
  });

  it("folds a section to a count and opens it again", () => {
    render(<Host />);
    const header = within(screen.getByRole("region", { name: "Needs you" })).getAllByRole("button")[0]!;
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(within(header).getByText("1")).toBeTruthy();
    expect(screen.queryByText("deploy")).toBeNull();
    fireEvent.click(header);
    expect(screen.getByText("deploy")).toBeTruthy();
  });

  it("folds sub-agents under their parent", () => {
    render(<Host />);
    expect(screen.getByText("helper")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide 1 sub-agents of tests" }));
    expect(screen.queryByText("helper")).toBeNull();
  });

  it("opens a terminal from its row and from the narrow rail", () => {
    const onSelect = vi.fn();
    const { unmount } = render(<Host onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /deploy/ }));
    expect(onSelect).toHaveBeenLastCalledWith("a");
    unmount();
    render(<Host onSelect={onSelect} rail />);
    const rail = screen.getAllByRole("button");
    expect(rail.map((button) => button.textContent?.replace(/\D/g, ""))).toEqual(["1", "2", "3", "4"]);
    fireEvent.click(screen.getByRole("button", { name: "shell" }));
    expect(onSelect).toHaveBeenLastCalledWith("c");
  });

  it("marks working terminals as working in the narrow rail", () => {
    render(<TerminalStatusSidebar rail now={NOW} folded={[]} onToggleFold={vi.fn()} onSelect={vi.fn()}
      rows={[{ key: "w", name: "build", machine: mac, status: "working" }, { key: "i", name: "zsh", machine: mac }]} />);
    expect(within(screen.getByRole("button", { name: "build" })).getByLabelText("Working")).toBeTruthy();
    expect(within(screen.getByRole("button", { name: "zsh" })).queryByLabelText("Working")).toBeNull();
  });
});

describe("one machine's terminal list", () => {
  it("lists exactly the rows it is given, most urgent first, and opens one", async () => {
    const { TerminalSidebarList } = await import("../../packages/ui/src/terminal-status-sidebar/index.js");
    const { render, screen, within, fireEvent, cleanup } = await import("@testing-library/react");
    const machine = { id: "computer:demo", name: "matrix-demo", remote: true };
    const onSelect = vi.fn();
    render(<TerminalSidebarList label="matrix-demo terminals" now={Date.now()} folded={[]} onToggleFold={() => undefined} onSelect={onSelect}
      rows={[{ key: "a", name: "idle shell", machine }, { key: "b", name: "agent", machine, status: "blocked" }]} />);
    const list = screen.getByRole("list", { name: "matrix-demo terminals" });
    expect(within(list).getAllByRole("button").map((button) => button.textContent)).toEqual([expect.stringContaining("agent"), expect.stringContaining("idle shell")]);
    fireEvent.click(within(list).getByRole("button", { name: /idle shell/ }));
    expect(onSelect).toHaveBeenCalledWith("a");
    cleanup();
  });
});
