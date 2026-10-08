import { filterTemplates, templateSetupPrompt, type AgentTemplate } from "../components/agents/agent-templates";

const templates: AgentTemplate[] = [
  { recipeId: "inbox-triage", version: "v1", name: "Inbox triage", description: "Sorts your inbox and drafts replies" },
  { recipeId: "daily-planner", version: "v1", name: "Daily planner", description: "Plans your day around meetings" },
  { recipeId: "account-research", version: "v2", name: "Account research", description: "Briefs you before every sales call" },
];

describe("template search", () => {
  it("returns every template for an empty or blank search", () => {
    expect(filterTemplates(templates, "")).toEqual(templates);
    expect(filterTemplates(templates, "   ")).toEqual(templates);
  });

  it("matches the name, whatever the case", () => {
    expect(filterTemplates(templates, "INBOX").map((template) => template.recipeId)).toEqual(["inbox-triage"]);
  });

  it("matches the description", () => {
    expect(filterTemplates(templates, "meetings").map((template) => template.recipeId)).toEqual(["daily-planner"]);
  });

  it("ignores space around the search", () => {
    expect(filterTemplates(templates, "  sales call ").map((template) => template.recipeId)).toEqual(["account-research"]);
  });

  it("matches nothing else: not the id, the version or what the template produces", () => {
    const withOutput = [{ ...templates[0], output: "A triaged mailbox" }];

    expect(filterTemplates(withOutput, "mailbox")).toEqual([]);
    expect(filterTemplates(templates, "v2")).toEqual([]);
    expect(filterTemplates(templates, "daily-planner")).toEqual([]);
  });
});

describe("the prompt for setting a template up in chat", () => {
  it("asks for an agent like the template, with the web's wording", () => {
    expect(templateSetupPrompt(templates[2])).toBe(
      "Help me create a Matrix agent inspired by “Account research”. Briefs you before every sales call. "
      + "Start by asking me the few decisions needed to tailor it. "
      + "Do not copy third-party private prompts; build an original agent for my needs.",
    );
  });

  it("does not add a second full stop to a description that already ends a sentence", () => {
    const prompt = templateSetupPrompt({ ...templates[0], description: "Sorts your inbox. Drafts replies!" });

    expect(prompt).toContain("“Inbox triage”. Sorts your inbox. Drafts replies! Start by asking me");
  });

  it("leaves the description out when the template has none", () => {
    const prompt = templateSetupPrompt({ ...templates[0], description: "  " });

    expect(prompt).toBe(
      "Help me create a Matrix agent inspired by “Inbox triage”. "
      + "Start by asking me the few decisions needed to tailor it. "
      + "Do not copy third-party private prompts; build an original agent for my needs.",
    );
  });

  it("never lists capabilities or integrations: the template list carries none", () => {
    const prompt = templateSetupPrompt(templates[1]);

    expect(prompt).not.toMatch(/capabilit|integration|none listed/i);
  });
});
