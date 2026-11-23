import { describe, expect, it } from "vitest";
import { filterActive, filterSpaces, shownMachineOrder, type FilterableMachine } from "@desktop/renderer/src/features/terminal-window/spaces-filter";

// ENG-521: ten Preview Computers drowned out This Mac, the Main Computer and the Additional computers.
const machines: FilterableMachine[] = [
  { id: "local", name: "This Mac", group: "this" },
  { id: "computer:primary", name: "hamedmp · Main Computer", group: "main" },
  { id: "computer:extra", name: "hamedmp · Additional Computer", group: "additional" },
  { id: "ssh:vps", name: "vps", group: "additional" },
  ...Array.from({ length: 10 }, (_, index) => ({ id: `computer:pr-${index}`, name: `pr-${index} · Preview Computer`, group: "preview" as const })),
];
const projects = (id: string) => (id === "computer:primary" ? ["matrix-os", "site"] : id === "local" ? ["dotfiles"] : []);

describe("Spaces filter", () => {
  it("lists previews under their own fold and every other kind in the list", () => {
    const result = filterSpaces(machines, "", [], projects);
    expect(result.shown.map((machine) => machine.id)).toEqual(["local", "computer:primary", "computer:extra", "ssh:vps"]);
    expect(result.previews).toHaveLength(10);
  });

  it("narrows by name, and by project name with only the matching projects", () => {
    expect(filterSpaces(machines, "pr-3", [], projects).previews.map((machine) => machine.id)).toEqual(["computer:pr-3"]);
    const bySpace = filterSpaces(machines, "SITE", [], projects);
    expect(bySpace.shown.map((machine) => machine.id)).toEqual(["computer:primary"]);
    const only = bySpace.projectsOf("computer:primary")!;
    expect(["matrix-os", "site"].filter(only)).toEqual(["site"]);
    // A machine that matches by its own name lists all its projects.
    expect(filterSpaces(machines, "main", [], projects).projectsOf("computer:primary")).toBeNull();
  });

  it("hides the kinds switched off", () => {
    const result = filterSpaces(machines, "", ["preview", "additional"], projects);
    expect(result.shown.map((machine) => machine.id)).toEqual(["local", "computer:primary"]);
    expect(result.previews).toEqual([]);
  });

  // Fault detected (Greptile, #3641): a renamed machine or project could not be found by the name shown.
  it("searches the names Spaces shows, renames included", () => {
    const shown = (machineId: string, space?: string) => (machineId === "computer:extra" && !space ? "Work server" : space === "site" ? "Marketing" : undefined);
    expect(filterSpaces(machines, "work", [], projects, shown).shown.map((machine) => machine.id)).toEqual(["computer:extra"]);
    const byProject = filterSpaces(machines, "marketing", [], projects, shown);
    expect(byProject.shown.map((machine) => machine.id)).toEqual(["computer:primary"]);
    expect(["matrix-os", "site"].filter(byProject.projectsOf("computer:primary")!)).toEqual(["site"]);
  });

  // Fault detected (Greptile, #3641): Ctrl+1…9 kept the unfiltered order.
  it("orders spaces for shortcuts as Spaces shows them, previews last and only while their fold is open", () => {
    const result = filterSpaces(machines, "", ["this"], projects);
    expect(shownMachineOrder(result, false)).toEqual(["computer:primary", "computer:extra", "ssh:vps"]);
    expect(shownMachineOrder(result, true)).toHaveLength(13);
    expect(filterActive("", [])).toBe(false);
    expect(filterActive(" ", ["preview"])).toBe(true);
    expect(filterActive("x", [])).toBe(true);
  });
});
