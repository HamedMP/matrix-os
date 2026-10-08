import { findReplyApps, replyAppCandidates } from "../components/chat/chat-app-references";

jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));

const apps = [
  { slug: "habit-tracker", name: "Habit tracker", path: "apps/habit-tracker/index.html" },
  { slug: "notes", name: "Notes", path: "apps/notes/dist/index.html" },
];

describe("replyAppCandidates", () => {
  it("collects link targets and inline code that point into the apps folder", () => {
    const text = "Saved to `~/apps/habit-tracker`. See [the app](/files/apps/notes/index.html) and `README.md`.";

    expect(replyAppCandidates(text)).toEqual(["~/apps/habit-tracker", "/files/apps/notes/index.html"]);
  });

  it("ignores plain prose, web links and fenced code", () => {
    const text = [
      "The apps/habit-tracker folder is ready. [Docs](https://example.com/apps/guide)",
      "```sh",
      "ls `~/apps/habit-tracker`",
      "```",
    ].join("\n");

    expect(replyAppCandidates(text)).toEqual([]);
  });

  it("still reads a fenced block that has not been closed yet as code", () => {
    expect(replyAppCandidates("```\n`~/apps/habit-tracker`")).toEqual([]);
  });

  it("returns nothing for an empty reply", () => {
    expect(replyAppCandidates("")).toEqual([]);
  });
});

describe("findReplyApps", () => {
  it("resolves a reference to the app in the catalog", () => {
    expect(findReplyApps("Created `~/apps/habit-tracker`.", apps, { allowRelative: true })).toEqual([apps[0]]);
  });

  it("resolves an app's entry file and its built entry file to the same app", () => {
    const text = "Open `~/apps/notes/dist/index.html` or [Notes](/files/apps/notes).";

    expect(findReplyApps(text, apps, { allowRelative: true })).toEqual([apps[1]]);
  });

  it("lists each app once, in the order the reply mentions them", () => {
    const text = "`~/apps/notes`, then `~/apps/habit-tracker`, then `~/apps/notes/index.html`.";

    expect(findReplyApps(text, apps, { allowRelative: true })).toEqual([apps[1], apps[0]]);
  });

  it("resolves nothing when no reference names a catalog app", () => {
    expect(findReplyApps("Created `~/apps/unknown` and `~/notes.md`.", apps, { allowRelative: true })).toEqual([]);
    expect(findReplyApps("Done. It has a daily checklist.", apps, { allowRelative: true })).toEqual([]);
  });

  it("accepts a path relative to the home folder only when that is allowed", () => {
    const text = "Created `apps/habit-tracker`.";

    expect(findReplyApps(text, apps, { allowRelative: true })).toEqual([apps[0]]);
    expect(findReplyApps(text, apps, { allowRelative: false })).toEqual([]);
    expect(findReplyApps("Created `~/apps/habit-tracker`.", apps, { allowRelative: false })).toEqual([apps[0]]);
  });

  it("skips catalog entries without a path", () => {
    expect(findReplyApps("`~/apps/habit-tracker`", [{ slug: "habit-tracker", name: "Habit tracker" }], { allowRelative: true })).toEqual([]);
  });
});
