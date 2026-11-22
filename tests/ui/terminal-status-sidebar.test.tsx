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

// Hamed, 2026-11-22: rows laid out like Herdr's agents list.
describe("terminal status sidebar rows, Herdr-style", () => {
  const herdrRows: TerminalSidebarRow[] = [
    { key: "p", name: "fix auth", space: "matrix-os", machine: vps, status: "working", statusAt: new Date(NOW - 16 * 3_600_000).toISOString() },
    { key: "q", name: "a much longer terminal title that has to truncate before the time column", machine: vps, statusAt: new Date(NOW - 22 * 3_600_000).toISOString() },
    { key: "r", name: "shell", machine: mac },
  ];
  const draw = (extra: Partial<React.ComponentProps<typeof TerminalStatusSidebar>> = {}) => render(
    <TerminalStatusSidebar rows={herdrRows} now={NOW} onSelect={vi.fn()} folded={[]} onToggleFold={vi.fn()} {...extra} />,
  );

  it("puts the project in bold before a muted title, with times and marks in fixed columns", () => {
    const { container } = draw();
    const project = screen.getByText("matrix-os");
    expect(project.className).toContain("font-semibold");
    expect(screen.getByText(/· fix auth/)).toBeTruthy();
    // Every row's time sits in the same fixed-width column, so 16h and 22h line up whatever the name's length.
    const times = [...container.querySelectorAll("span.tabular-nums.w-8")].map((time) => time.textContent);
    expect(times).toEqual(expect.arrayContaining(["16h", "22h"]));
    for (const time of container.querySelectorAll("span.tabular-nums.w-8")) expect(time.className).toContain("shrink-0");
    expect(container.querySelector("span.truncate")).toBeTruthy();
  });

  it("lists pinned terminals first and offers pin and close on each row", () => {
    const onTogglePin = vi.fn();
    const onClose = vi.fn();
    draw({ pinned: ["r"], onTogglePin, onClose });
    const sections = screen.getAllByRole("region").map((section) => section.getAttribute("aria-label"));
    expect(sections[0]).toBe("Pinned");
    const shellActions = screen.getByRole("group", { name: "shell actions" });
    fireEvent.click(within(shellActions).getByRole("button", { name: "Unpin terminal" }));
    expect(onTogglePin).toHaveBeenCalledWith("r");
    fireEvent.click(within(screen.getByRole("group", { name: "fix auth actions" })).getByRole("button", { name: "Close terminal" }));
    expect(onClose).toHaveBeenCalledWith("p");
  });

  it("names a row's machine only where machines mix: not inside its own group or a machine filter", () => {
    const { unmount } = draw();
    expect(screen.getAllByText("Main Computer").length).toBeGreaterThan(0);
    unmount();
    const grouped = draw({ view: "machine" });
    const group = screen.getByRole("region", { name: "Main Computer" });
    // The group header names it once; its rows do not, and they are inset under it.
    expect(within(group).getAllByText("Main Computer")).toHaveLength(1);
    const insetRow = within(group).getByRole("button", { name: /fix auth/ }).parentElement!;
    expect(insetRow.style.paddingLeft).toBe("16px");
    grouped.unmount();
    draw({ oneMachine: true });
    expect(screen.queryByText("Main Computer")).toBeNull();
  });

  it("hangs sub-agents from their parent on a connector line, with a fold chevron", () => {
    const { container } = render(<Host />);
    const toggle = screen.getByRole("button", { name: /sub-agents of tests/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelectorAll("li > ul > span[aria-hidden=true].w-px")).toHaveLength(1);
    fireEvent.click(toggle);
    expect(screen.queryByText("helper")).toBeNull();
  });
});
