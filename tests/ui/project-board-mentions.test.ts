import { describe, expect, it } from "vitest";
import { insertMention, mentionQueryAt, mentionedHandles } from "../../packages/ui/src/project-board/mentions";

describe("mentionQueryAt", () => {
  it("finds the handle being typed after an @ at a word start", () => {
    expect(mentionQueryAt("Ping @an", 8)).toEqual({ start: 5, query: "an" });
    expect(mentionQueryAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQueryAt("(@yu", 4)).toEqual({ start: 1, query: "yu" });
  });

  it("ignores email addresses, finished mentions and text after the caret", () => {
    expect(mentionQueryAt("mail ana@example.com", 20)).toBeNull();
    expect(mentionQueryAt("@ana done", 9)).toBeNull();
    expect(mentionQueryAt("no mention here", 15)).toBeNull();
    expect(mentionQueryAt("@ana", 0)).toBeNull();
  });
});

describe("insertMention", () => {
  it("replaces the partial handle and leaves the caret after a space", () => {
    expect(insertMention("Ping @an please", 5, 8, "ana")).toEqual({ text: "Ping @ana please", caret: 10 });
    expect(insertMention("@", 0, 1, "sam")).toEqual({ text: "@sam ", caret: 5 });
  });
});

describe("mentionedHandles", () => {
  it("lists known handles mentioned in a comment once each", () => {
    expect(mentionedHandles("@ana and @yuki, also @ana and @nobody", ["ana", "yuki", "sam"])).toEqual(["ana", "yuki"]);
  });
});
