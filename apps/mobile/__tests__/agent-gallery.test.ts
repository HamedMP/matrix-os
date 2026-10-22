import {
  ALL_CATEGORIES,
  buildAgentGallery,
  GALLERY_CATEGORIES,
  inspirationSetupPrompt,
  LAUNCH_RECIPE_IDS,
} from "../components/agents/agent-gallery";
import { agentInspirations } from "../components/agents/agent-inspirations.generated";
import type { AgentTemplate } from "../components/agents/agent-templates";

const everything = { query: "", category: ALL_CATEGORIES };

// Two of the computer's templates: one the gallery also knows as an
// inspiration, under Sales, and one it does not know.
const accountBook: AgentTemplate = {
  recipeId: "account-book",
  version: "v3",
  name: "Account Research Desk",
  description: "Researches an account from public sources and your notes",
};
const dailyBrief: AgentTemplate = {
  recipeId: "personal-daily-brief",
  version: "v1",
  name: "Daily Brief",
  description: "Reads your calendar and inbox and writes a short brief for the day",
};

function ids(gallery: ReturnType<typeof buildAgentGallery>) {
  return {
    templates: gallery.templates.map((template) => template.recipeId),
    inspirations: gallery.inspirations.map((inspiration) => inspiration.id),
  };
}

describe("the gallery's categories", () => {
  it("offers everything first, then the first seven categories of the inventory", () => {
    expect(GALLERY_CATEGORIES).toEqual([
      "All", "Sales", "Marketing", "Operations", "Personal", "Product", "Design", "Engineering",
    ]);
    expect(GALLERY_CATEGORIES[0]).toBe(ALL_CATEGORIES);
  });
});

describe("the gallery with nothing searched for", () => {
  it("lists every inspiration the computer has no template of its own for, in the inventory's order", () => {
    const gallery = buildAgentGallery([], everything);

    expect(agentInspirations).toHaveLength(71);
    expect(gallery.templates).toEqual([]);
    expect(gallery.inspirations).toHaveLength(66);
    expect(gallery.inspirations).toEqual(
      agentInspirations.filter((inspiration) => !LAUNCH_RECIPE_IDS.includes(inspiration.id)),
    );
  });

  it("leaves out the launch templates, which only the computer offers", () => {
    const { inspirations } = ids(buildAgentGallery([], everything));

    for (const id of ["account-book", "competitor-watching", "event-request-desk", "echo", "writing-bot"]) {
      expect(LAUNCH_RECIPE_IDS).toContain(id);
      expect(inspirations).not.toContain(id);
    }
  });

  it("keeps the computer's templates as they came, ahead of the inspirations", () => {
    const gallery = buildAgentGallery([dailyBrief, accountBook], everything);

    expect(gallery.templates).toEqual([dailyBrief, accountBook]);
    expect(gallery.inspirations).toHaveLength(66);
  });

  it("drops an inspiration the computer has a template for, so nothing is listed twice", () => {
    const callFollowUps: AgentTemplate = { ...dailyBrief, recipeId: "call-follow-ups", name: "Call Follow-Ups" };
    expect(agentInspirations.map((inspiration) => inspiration.id)).toContain("call-follow-ups");

    const gallery = ids(buildAgentGallery([callFollowUps], everything));

    expect(gallery.templates).toEqual(["call-follow-ups"]);
    expect(gallery.inspirations).not.toContain("call-follow-ups");
    expect(gallery.inspirations).toHaveLength(65);
  });
});

describe("the gallery under a category", () => {
  it("lists the inspirations of that category only", () => {
    const gallery = buildAgentGallery([], { query: "", category: "Engineering" });

    expect(gallery.inspirations.length).toBeGreaterThan(0);
    expect(gallery.inspirations.every((inspiration) => inspiration.categories.includes("Engineering"))).toBe(true);
    expect(gallery.inspirations).toEqual(
      agentInspirations.filter((inspiration) => (
        inspiration.categories.includes("Engineering") && !LAUNCH_RECIPE_IDS.includes(inspiration.id)
      )),
    );
  });

  it("files a template of the computer under the categories of the inspiration it shares an id with", () => {
    const recipes = [dailyBrief, accountBook];

    expect(ids(buildAgentGallery(recipes, { query: "", category: "Sales" })).templates).toEqual(["account-book"]);
    expect(ids(buildAgentGallery(recipes, { query: "", category: "Design" })).templates).toEqual([]);
  });

  it("has something under every category, also when the computer's templates could not be read", () => {
    for (const category of GALLERY_CATEGORIES) {
      expect(buildAgentGallery([], { query: "", category }).inspirations.length).toBeGreaterThan(0);
    }
  });

  it("lists nothing under a category the inventory does not have", () => {
    expect(ids(buildAgentGallery([dailyBrief], { query: "", category: "Gardening" }))).toEqual({
      templates: [],
      inspirations: [],
    });
  });
});

describe("the gallery under a search", () => {
  it("matches a template of the computer by its name and description, whatever the case", () => {
    const recipes = [dailyBrief, accountBook];

    expect(ids(buildAgentGallery(recipes, { query: " DAILY brief ", category: ALL_CATEGORIES })).templates)
      .toEqual(["personal-daily-brief"]);
    expect(ids(buildAgentGallery(recipes, { query: "public sources", category: ALL_CATEGORIES })).templates)
      .toEqual(["account-book"]);
  });

  it.each([
    ["its name", "ad spend watch", "fuse"],
    ["its description", "burns budget", "fuse"],
    ["a skill", "check budget pace", "fuse"],
    ["an app it works with", "DATADOG", "fuse"],
  ])("matches an inspiration by %s", (_field, query, id) => {
    expect(ids(buildAgentGallery([], { query, category: ALL_CATEGORIES })).inspirations).toContain(id);
  });

  it("matches an inspiration by its category", () => {
    const { inspirations } = buildAgentGallery([], { query: "recruiting", category: ALL_CATEGORIES });

    expect(inspirations.length).toBeGreaterThan(0);
    expect(inspirations.some((inspiration) => inspiration.categories.includes("Recruiting & People"))).toBe(true);
  });

  it("applies the search inside the chosen category", () => {
    const everywhere = ids(buildAgentGallery([], { query: "gmail", category: ALL_CATEGORIES })).inspirations;
    const inSales = buildAgentGallery([], { query: "gmail", category: "Sales" }).inspirations;

    expect(inSales.length).toBeGreaterThan(0);
    expect(inSales.length).toBeLessThan(everywhere.length);
    expect(inSales.every((inspiration) => inspiration.categories.includes("Sales"))).toBe(true);
  });

  it("lists nothing when nothing matches", () => {
    expect(ids(buildAgentGallery([dailyBrief], { query: "zzzz-no-such-agent", category: ALL_CATEGORIES }))).toEqual({
      templates: [],
      inspirations: [],
    });
  });
});

describe("the prompt for building an inspiration in chat", () => {
  const fuse = agentInspirations.find((inspiration) => inspiration.id === "fuse")!;

  it("asks for an agent like it, naming its first five skills and apps, with the web's wording", () => {
    expect(inspirationSetupPrompt(fuse)).toBe(
      "Help me create a Matrix agent inspired by “Ad Spend Watch”. "
      + "Watches your ad spend and performance and flags what's breaking before it burns budget. "
      + "Works from a pasted export, and never pauses a campaign without your yes. "
      + "Start by asking me the few decisions needed to tailor it. "
      + `Suggested capabilities: ${fuse.skills.slice(0, 5).join(", ")}. `
      + `Possible integrations: ${fuse.integrations.slice(0, 5).join(", ")}. `
      + "Do not copy third-party private prompts; build an original agent for my needs.",
    );
    expect(fuse.skills.length).toBeGreaterThan(5);
    expect(inspirationSetupPrompt(fuse)).not.toContain(fuse.skills[5]);
  });

  it("says so when an inspiration lists no skills or apps", () => {
    const prompt = inspirationSetupPrompt({ ...fuse, skills: [], integrations: [] });

    expect(prompt).toContain("Suggested capabilities: none listed. Possible integrations: none listed.");
  });
});
