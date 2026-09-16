// @vitest-environment jsdom
import React, { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatAgentRecipe, ChatAgentRecipeCatalog } from "@matrix-os/contracts";
import { AgentRecipeEditor } from "../../packages/ui/src/chat-agents/AgentRecipeEditor.js";

afterEach(cleanup);
const skills = [
  { id: "code-review", name: "Code review", description: "Review a pull request." },
  { id: "meeting-notes", name: "Meeting notes", description: "Summarize decisions." },
  { id: "matrix-integrations", name: "Matrix Integrations", description: "Use connected services." },
];

function Editor({ catalog = { enabled: true, skills, services: [] }, selected = [] }: {
  catalog?: ChatAgentRecipeCatalog; selected?: string[];
}) {
  const [recipe, setRecipe] = useState<ChatAgentRecipe | null | undefined>({ skills: selected, integrations: [], output: "Report" });
  return <><AgentRecipeEditor recipe={recipe} hadRecipe={false} catalog={catalog} connections={[]}
    loading={false} error="" connectionError="" pending={false} onChange={setRecipe} onRetry={() => undefined} />
    <output aria-label="Saved skill choices">{recipe?.skills.join(",")}</output></>;
}

describe("installed Recipe skill selection", () => {
  it("searches names and descriptions without dropping selections across searches", () => {
    render(<Editor />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Code review" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search skills" }), { target: { value: " DECISIONS " } });
    expect(screen.queryByRole("checkbox", { name: "Matrix Integrations" })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Meeting notes" }));
    expect(screen.getByLabelText("Saved skill choices").textContent).toBe("code-review,meeting-notes");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search skills" }), { target: { value: "code" } });
    expect((screen.getByRole("checkbox", { name: "Code review" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Code review" }));
    expect(screen.getByLabelText("Saved skill choices").textContent).toBe("meeting-notes");
  });

  it("explains an empty search and allows clearing it without changing selected skills", () => {
    render(<Editor selected={["code-review"]} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search skills" }), { target: { value: "absent" } });
    expect(screen.getByText("No skills match your search.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear skill search" }));
    expect((screen.getByRole("checkbox", { name: "Code review" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("checkbox", { name: "Meeting notes" })).toBeTruthy();
  });

  it("keeps unavailable saved selections visible and removable during search", () => {
    render(<Editor selected={["removed-skill"]} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search skills" }), { target: { value: "code" } });
    const removed = screen.getByRole("checkbox", { name: "removed-skill · unavailable" });
    expect((removed as HTMLInputElement).checked).toBe(true);
    fireEvent.click(removed);
    expect(screen.getByLabelText("Saved skill choices").textContent).toBe("");
  });

  it("prevents a ninth selection while allowing a selected skill to be removed", () => {
    const catalogueSkills = Array.from({ length: 9 }, (_, i) => ({ id: `skill-${i}`, name: `Skill ${i}`, description: "Workflow" }));
    render(<Editor catalog={{ enabled: true, skills: catalogueSkills, services: [] }}
      selected={catalogueSkills.slice(0, 8).map((skill) => skill.id)} />);
    expect((screen.getByRole("checkbox", { name: "Skill 8" }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Skill 0" }));
    expect((screen.getByRole("checkbox", { name: "Skill 8" }) as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("checkbox", { name: "Skill 8" }));
    expect(screen.getByLabelText("Saved skill choices").textContent).toBe("skill-1,skill-2,skill-3,skill-4,skill-5,skill-6,skill-7,skill-8");
  });

  it("prevents combinations exceeding the instruction budget and re-enables them after removal", () => {
    render(<Editor catalog={{ enabled: true, skills: [
      { ...skills[0]!, instructionBytes: 16_000 },
      { ...skills[1]!, instructionBytes: 12_000 },
      { ...skills[2]!, instructionBytes: 3_000 },
    ], services: [] }} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Code review" }));
    expect((screen.getByRole("checkbox", { name: "Meeting notes" }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Matrix Integrations" }) as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("checkbox", { name: "Code review" }));
    expect((screen.getByRole("checkbox", { name: "Meeting notes" }) as HTMLInputElement).disabled).toBe(false);
  });

  it("shows more results in the page and starts a new search from its first matches", () => {
    const catalogueSkills = Array.from({ length: 25 }, (_, i) => ({ id: `skill-${i}`, name: `Skill ${i}`, description: "Workflow" }));
    render(<Editor catalog={{ enabled: true, skills: catalogueSkills, services: [] }} />);
    expect(screen.getAllByRole("checkbox")).toHaveLength(12);
    fireEvent.click(screen.getByRole("button", { name: "Show more skills" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Skill 20" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search skills" }), { target: { value: "Skill 24" } });
    expect(screen.getByRole("checkbox", { name: "Skill 24" })).toBeTruthy();
    expect(screen.getByLabelText("Saved skill choices").textContent).toBe("skill-20");
  });
});
