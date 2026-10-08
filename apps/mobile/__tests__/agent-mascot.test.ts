import { deriveAgentMascot, mascotHash } from "../lib/agent-mascot";

// Expected values were produced by running the web component
// (packages/ui/src/chat-agents/RecipeRabbit.tsx) on the same inputs.
const FACES = [
  "M7 29C7 18 14 11 24 11s17 7 17 18c0 10-7 16-17 16S7 39 7 29Z",
  "M6 31C7 18 16 9 27 11c10 2 16 11 14 21-2 9-10 14-20 13C11 44 5 39 6 31Z",
  "M9 39C4 32 8 19 21 10c3-2 6-2 9 0 11 8 15 20 10 28-6 9-23 10-31 1Z",
  "M5 28c0-11 8-18 19-18s19 7 19 18-7 17-19 17S5 39 5 28Z",
];
const EARS = [
  ["M12 20C10 14 10 5 15 2c6 1 7 11 5 18Z", "M28 20C27 12 29 2 35 2c5 4 2 14-1 19Z"],
  ["M13 20C9 14 10 6 15 3c5 1 7 10 5 17Z", "M28 20C27 12 30 4 35 3c5 4 2 13-1 18Z"],
  ["M14 20C12 13 13 5 17 2c5 3 5 12 3 18Z", "M28 20c0-8 3-16 7-18 5 4 3 14-1 19Z"],
];

describe("mascotHash", () => {
  it.each<[string, number]>([
    ["", 0],
    ["a", 97],
    ["c", 99],
    ["agent-1", 578178541],
    ["launch-tracker", 465826548],
    ["my-inbox", 1794149779],
    ["account-research", 3157145063],
    ["competitor-watch", 3502551434],
    ["héllo-🙂", 1829432962],
  ])("hashes %j to %i", (id, hash) => {
    expect(mascotHash(id)).toBe(hash);
  });
});

describe("deriveAgentMascot", () => {
  it.each<[string, string | undefined, string, string, string, string]>([
    ["account-research", "Sales", "sales", "coral", "#F07A61", "#FFE9E3"],
    ["my-inbox", "productivity", "productivity", "teal", "#35B7A7", "#DDF6F1"],
    ["competitor-watch", "Market research", "research", "blue", "#4388E8", "#E5F0FF"],
    ["launch-tracker", "operations", "operations", "amber", "#F1A23E", "#FFF1D9"],
    ["7f3c2a", "Engineering & DevOps", "engineering", "violet", "#6D63E8", "#ECEAFF"],
    ["x5", "Marketing", "marketing", "plum", "#A95EA4", "#F7E7F5"],
    ["x3", " Finance ", "finance", "moss", "#75A951", "#EAF5E1"],
    ["x2", "CREATIVE", "creative", "rose", "#D86691", "#FCE8F0"],
  ])("colours %j in category %j by its task", (id, category, task, color, body, wash) => {
    expect(deriveAgentMascot(id, category)).toMatchObject({ task, color, body, wash });
  });

  it("takes the first task in the web's order when a category names two", () => {
    expect(deriveAgentMascot("x1", "Marketing & sales")).toMatchObject({ task: "sales", color: "coral" });
  });

  it.each<[string, string | undefined, string, string]>([
    ["agent-1", undefined, "moss", "#75A951"],
    ["agent-2", "  ", "amber", "#F1A23E"],
    ["x4", "", "plum", "#A95EA4"],
    ["bot_01HZX", "Unknown", "rose", "#D86691"],
    ["a", undefined, "violet", "#6D63E8"],
    ["b", undefined, "coral", "#F07A61"],
    ["c", undefined, "blue", "#4388E8"],
    ["d", undefined, "plum", "#A95EA4"],
  ])("colours %j in category %j from its id when no task matches", (id, category, color, body) => {
    expect(deriveAgentMascot(id, category)).toMatchObject({ task: "general", color, body });
  });

  it.each<[string, number, number, [number, number], boolean]>([
    ["account-research", 3, 2, [15, 29], false],
    ["my-inbox", 3, 1, [15, 29], false],
    ["competitor-watch", 2, 2, [14, 30], false],
    ["launch-tracker", 0, 0, [14, 30], true],
    ["agent-1", 1, 1, [15, 29], false],
    ["", 0, 0, [14, 30], true],
    ["héllo-🙂", 2, 1, [14, 30], false],
    ["c", 3, 0, [15, 29], true],
  ])("draws %j with face %i, ears %i, eyes at %j and nose %j", (id, face, ears, eyes, hasNose) => {
    const mascot = deriveAgentMascot(id, "sales");

    expect(mascot.face).toBe(FACES[face]);
    expect(mascot.ears.map((ear) => ear.d)).toEqual(EARS[ears]);
    expect(mascot.eyes.map((eye) => eye.x)).toEqual(eyes);
    expect(mascot.hasNose).toBe(hasNose);
  });

  it("does not let the category change the face, ears, eyes or nose", () => {
    const { face, ears, eyes, hasNose } = deriveAgentMascot("my-inbox", "productivity");

    expect(deriveAgentMascot("my-inbox", "finance")).toMatchObject({ face, ears, eyes, hasNose });
    expect(deriveAgentMascot("my-inbox")).toMatchObject({ face, ears, eyes, hasNose });
  });

  it("holds the ears in the web's idle pose, turned about the bottom centre of each ear", () => {
    expect(deriveAgentMascot("launch-tracker").ears.map((ear) => ear.transform)).toEqual([
      "translate(15.84 19) scale(1 0.96) rotate(-5) translate(-15.84 -20)",
      "translate(32.71 20) scale(1 0.96) rotate(5) translate(-32.71 -21)",
    ]);
    expect(deriveAgentMascot("my-inbox").ears.map((ear) => ear.transform)).toEqual([
      "translate(15.65 19) scale(1 0.96) rotate(-5) translate(-15.65 -20)",
      "translate(32.74 20) scale(1 0.96) rotate(5) translate(-32.74 -21)",
    ]);
    expect(deriveAgentMascot("account-research").ears.map((ear) => ear.transform)).toEqual([
      "translate(17.12 19) scale(1 0.96) rotate(-5) translate(-17.12 -20)",
      "translate(32.98 20) scale(1 0.96) rotate(5) translate(-32.98 -21)",
    ]);
  });

  it("tilts both eyes the same way, each about its own centre", () => {
    expect(deriveAgentMascot("a").eyes.map((eye) => eye.transform)).toEqual([
      "rotate(-12 15.6 28)",
      "rotate(-12 31.6 28)",
    ]);
  });
});
