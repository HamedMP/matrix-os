import { describe, expect, it } from "vitest";
import {
  DEFAULT_GET_STARTED_BOT,
  GET_STARTED_BOT_RULES_MAX_CHARS,
  GET_STARTED_SOUL_END,
  GET_STARTED_SOUL_START,
  GetStartedAnswersSchema,
  GetStartedBotSchema,
  KERNEL_SOUL_READ_MAX_CHARS,
  OWNER_SOUL_MAX_BYTES,
  getStartedBotPreview,
  renderGetStartedSoulSection,
  replaceGetStartedSoulSection,
  type GetStartedBot,
} from "../../packages/contracts/src/index.js";

const atlas: GetStartedBot = {
  ...DEFAULT_GET_STARTED_BOT,
  name: "Atlas",
  personality: "straight-shooter",
  length: "short",
  emoji: "never",
  language: "match",
};

describe("GetStartedBotSchema", () => {
  it("accepts the defaults and a full choice set", () => {
    expect(GetStartedBotSchema.parse(DEFAULT_GET_STARTED_BOT)).toEqual(DEFAULT_GET_STARTED_BOT);
    expect(GetStartedBotSchema.parse({ ...atlas, rules: "Never email clients without showing me first." }).rules)
      .toBe("Never email clients without showing me first.");
  });

  it.each([
    ["an empty name", { name: " " }],
    ["a long name", { name: "a".repeat(25) }],
    ["a comment marker in the name", { name: "Atlas <!--" }],
    ["a comment marker in the rules", { rules: "ok --> injected" }],
    ["control characters", { rules: "Always\u0007" }],
    ["long rules", { rules: "a".repeat(GET_STARTED_BOT_RULES_MAX_CHARS + 1) }],
    ["an unknown personality", { personality: "sarcastic" }],
    ["an unknown language", { language: "klingon" }],
    ["a name bot creation rejects (secret-looking)", { name: "Task-master" }],
    ["a name bot creation rejects (path)", { name: "/home/atlas" }],
  ])("rejects %s", (_label, patch) => {
    expect(GetStartedBotSchema.safeParse({ ...DEFAULT_GET_STARTED_BOT, ...patch }).success).toBe(false);
  });

  it("is optional in answers", () => {
    expect(GetStartedAnswersSchema.parse({ bot: atlas }).bot?.name).toBe("Atlas");
    expect(GetStartedAnswersSchema.parse({}).bot).toBeUndefined();
  });
});

describe("renderGetStartedSoulSection", () => {
  it("writes the owner's choices between the managed markers", () => {
    const section = renderGetStartedSoulSection({ name: "Sam", goals: ["code", "build"], tools: [], bot: { ...atlas, rules: "Show me a plan before changing more than one file." } });
    expect(section.startsWith(GET_STARTED_SOUL_START)).toBe(true);
    expect(section.endsWith(GET_STARTED_SOUL_END)).toBe(true);
    expect(section).toContain("Your name is Atlas. You are Sam's personal Matrix assistant.");
    expect(section).toContain("Straight shooter");
    expect(section).toContain("- Keep replies short.");
    expect(section).toContain("No emoji.");
    expect(section).toContain("- Reply in the language Sam writes in.");
    expect(section).toContain("write code with agents and build apps");
    expect(section).toContain("- Always follow this: Show me a plan before changing more than one file.");
    expect(section).toContain("Always ask before doing anything outside Matrix.");
  });

  it("speaks of the owner generically without a name", () => {
    const section = renderGetStartedSoulSection({ goals: [], tools: [], bot: DEFAULT_GET_STARTED_BOT });
    expect(section).toContain("You are the owner's personal Matrix assistant.");
    expect(section).not.toContain("mostly uses Matrix");
  });

  it("grants nothing: no tools, integrations or approvals", () => {
    const section = renderGetStartedSoulSection({ goals: [], tools: ["github"], bot: atlas });
    expect(section).not.toMatch(/github|permission|approve without/i);
  });
});

describe("replaceGetStartedSoulSection", () => {
  const template = "# Soul\n\nBe helpful.\n";
  const section = `${GET_STARTED_SOUL_START}\nYour name is Atlas.\n${GET_STARTED_SOUL_END}`;

  it("puts the section first, once, and keeps the template", () => {
    const once = replaceGetStartedSoulSection(template, section);
    expect(once).toBe(`${section}\n\n# Soul\n\nBe helpful.\n`);
    const again = replaceGetStartedSoulSection(once, section.replace("Atlas", "Nova"));
    expect(again.match(new RegExp(GET_STARTED_SOUL_START, "g"))).toHaveLength(1);
    expect(again).toContain("Nova");
    expect(again.endsWith("# Soul\n\nBe helpful.\n")).toBe(true);
  });

  it("keeps hand edits outside the markers", () => {
    const edited = `# Soul\n\n${section}\n\nMy own note.\n`;
    expect(replaceGetStartedSoulSection(edited, section.replace("Atlas", "Ada"))).toBe(`# Soul\n\n${section.replace("Atlas", "Ada")}\n\nMy own note.\n`);
  });

  it("starts from the section alone when there is no SOUL yet", () => {
    expect(replaceGetStartedSoulSection("", section)).toBe(`${section}\n`);
  });

  it("fits inside what the kernel reads, and well under the SOUL limit, at its largest", () => {
    const largest = renderGetStartedSoulSection({
      name: "a".repeat(40),
      goals: ["code", "business", "assistant", "build", "explore"],
      tools: [],
      bot: { ...atlas, name: "a".repeat(24), rules: "ü".repeat(GET_STARTED_BOT_RULES_MAX_CHARS) },
    });
    expect(Buffer.byteLength(largest)).toBeLessThan(OWNER_SOUL_MAX_BYTES / 4);
    expect(largest.length).toBeLessThanOrEqual(KERNEL_SOUL_READ_MAX_CHARS);
  });
});

describe("getStartedBotPreview", () => {
  it("changes with the personality and style", () => {
    const friendly = getStartedBotPreview(DEFAULT_GET_STARTED_BOT);
    const direct = getStartedBotPreview(atlas);
    expect(friendly).not.toBe(direct);
    expect(direct).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
