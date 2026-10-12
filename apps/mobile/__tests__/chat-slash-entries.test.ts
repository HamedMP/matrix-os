import { chatSlashEntries, draftWithInvocation } from "../lib/chat-slash-entries";

import { GPT, SONNET, catalogOf, codexInstance, matrixInstance } from "./model-test-catalog";

jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));

const review = { id: "review", displayName: "Review", description: "Reviews the changes", invocation: "/review" };
const builder = { id: "app-builder", displayName: "App builder", description: "Builds a small app", invocation: "/app-builder" };

describe("skills and commands", () => {
  it("lists the selected engine's skills, then its commands", () => {
    const catalog = catalogOf(codexInstance(undefined, { skills: [builder], commands: [review] }));

    expect(chatSlashEntries(catalog, GPT)).toEqual([
      { id: "skill:app-builder", kind: "skill", name: "App builder", description: "Builds a small app", invocation: "/app-builder" },
      { id: "command:review", kind: "command", name: "Review", description: "Reviews the changes", invocation: "/review" },
    ]);
  });

  it("does not offer another engine's in their place", () => {
    const catalog = catalogOf(
      matrixInstance(undefined, { skills: [], commands: [] }),
      codexInstance(undefined, { skills: [builder], commands: [review] }),
    );

    expect(chatSlashEntries(catalog, SONNET)).toEqual([]);
  });

  it("keeps a skill and a command of the same id apart", () => {
    const catalog = catalogOf(codexInstance(undefined, { skills: [review], commands: [review] }));

    expect(chatSlashEntries(catalog, GPT).map((entry) => entry.id)).toEqual(["skill:review", "command:review"]);
  });

  it("has none while the model or the catalog is not known, or the engine cannot run", () => {
    const catalog = catalogOf(codexInstance(undefined, { skills: [builder], commands: [review] }));

    expect(chatSlashEntries(null, GPT)).toEqual([]);
    expect(chatSlashEntries(catalog, null)).toEqual([]);
    expect(chatSlashEntries(catalogOf(codexInstance(undefined, {
      availability: "unavailable", skills: [builder], commands: [],
    })), GPT)).toEqual([]);
  });

  describe("putting one in a draft", () => {
    it("starts an empty draft with it, ready for what follows", () => {
      expect(draftWithInvocation("", "/review")).toBe("/review ");
    });

    it("goes before what is already written", () => {
      expect(draftWithInvocation("the login screen", "/review")).toBe("/review the login screen");
      expect(draftWithInvocation("  the login screen", "/review")).toBe("/review the login screen");
    });

    it("replaces one the draft already starts with", () => {
      expect(draftWithInvocation("/app-builder a habit tracker", "/review")).toBe("/review a habit tracker");
      expect(draftWithInvocation("/app-builder", "/review")).toBe("/review ");
    });

    it("leaves alone a slash that is not a skill at the start", () => {
      expect(draftWithInvocation("see /etc/hosts", "/review")).toBe("/review see /etc/hosts");
      expect(draftWithInvocation("/etc/hosts is wrong", "/review")).toBe("/review /etc/hosts is wrong");
    });
  });
});
