import { describe, expect, it } from "vitest";
import {
  terminalStatusSections,
  terminalSinceLabel,
  type TerminalSidebarRow,
} from "../../packages/ui/src/terminal-status-sidebar/model";

const NOW = Date.parse("2026-11-21T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const mac = { id: "local", name: "This Mac", remote: false };
const vps = { id: "primary", name: "Main Computer", remote: true };

function row(key: string, extra: Partial<TerminalSidebarRow> = {}): TerminalSidebarRow {
  return { key, name: key, machine: mac, ...extra };
}

describe("terminal status sidebar sections", () => {
  // The person scans for what needs them first, as in Herdr: Needs you, Done, Working, Idle.
  it("sorts terminals into Herdr's sections in Herdr's order", () => {
    const sections = terminalStatusSections([
      row("idle-shell"),
      row("builder", { status: "working", statusAt: ago(60_000) }),
      row("asks", { status: "blocked", statusAt: ago(5_000) }),
      row("crashed", { status: "error", statusAt: ago(1_000) }),
      row("finished", { status: "done", statusAt: ago(120_000) }),
    ]);
    expect(sections.map((section) => [section.id, section.rows.map((entry) => entry.key)])).toEqual([
      ["needs-you", ["crashed", "asks"]],
      ["done", ["finished"]],
      ["working", ["builder"]],
      ["idle", ["idle-shell"]],
    ]);
  });

  it("moves a finished terminal to Idle once the person has seen it", () => {
    const sections = terminalStatusSections([row("finished", { status: "done", seen: true })]);
    expect(sections.map((section) => section.id)).toEqual(["idle"]);
  });

  it("leaves out empty sections", () => {
    expect(terminalStatusSections([])).toEqual([]);
  });

  it("puts sub-agents under their parent, which takes their most urgent status", () => {
    const sections = terminalStatusSections([
      row("lead", { status: "working" }),
      row("helper", { status: "blocked", parentKey: "lead" }),
      row("other", { status: "working" }),
    ]);
    expect(sections[0]).toMatchObject({ id: "needs-you", rows: [{ key: "lead", status: "blocked", children: [{ key: "helper" }] }] });
    expect(sections[1]).toMatchObject({ id: "working", rows: [{ key: "other" }] });
  });

  it("groups by machine when asked, most urgent first within each", () => {
    const sections = terminalStatusSections([
      row("a", { status: "idle" }),
      row("b", { status: "blocked", machine: vps }),
      row("c", { status: "working" }),
    ], { view: "machine" });
    expect(sections.map((section) => [section.id, section.label, section.rows.map((entry) => entry.key)])).toEqual([
      ["machine:local", "This Mac", ["c", "a"]],
      ["machine:primary", "Main Computer", ["b"]],
    ]);
    expect(sections[1]!.status).toBe("blocked");
  });
});

describe("time since the last change", () => {
  it("reads like Herdr's", () => {
    expect(terminalSinceLabel(ago(10_000), NOW)).toBe("<1m");
    expect(terminalSinceLabel(ago(5 * 60_000), NOW)).toBe("5m");
    expect(terminalSinceLabel(ago(2 * 3_600_000), NOW)).toBe("2h");
    expect(terminalSinceLabel(ago(3 * 86_400_000), NOW)).toBe("3d");
    expect(terminalSinceLabel(undefined, NOW)).toBeNull();
    expect(terminalSinceLabel("not a date", NOW)).toBeNull();
  });
});
