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
    const known = ["/review", "/app-builder"];

    it("starts an empty draft with it, ready for what follows", () => {
      expect(draftWithInvocation("", "/review", known)).toBe("/review ");
    });

    it("goes before what is already written", () => {
      expect(draftWithInvocation("the login screen", "/review", known)).toBe("/review the login screen");
      expect(draftWithInvocation("  the login screen", "/review", known)).toBe("/review the login screen");
    });

    it("replaces one of the model's own that the draft already starts with", () => {
      expect(draftWithInvocation("/app-builder a habit tracker", "/review", known)).toBe("/review a habit tracker");
      expect(draftWithInvocation("/app-builder", "/review", known)).toBe("/review ");
      expect(draftWithInvocation("/review", "/review", known)).toBe("/review ");
    });

    it("keeps a path the draft starts with, though it begins like one", () => {
      expect(draftWithInvocation("/tmp contains the logs", "/review", known)).toBe("/review /tmp contains the logs");
      expect(draftWithInvocation("/etc/hosts is wrong", "/review", known)).toBe("/review /etc/hosts is wrong");
      expect(draftWithInvocation("see /etc/hosts", "/review", known)).toBe("/review see /etc/hosts");
    });

    it("keeps a first word that only begins with one of the model's own", () => {
      expect(draftWithInvocation("/reviewer notes", "/app-builder", known)).toBe("/app-builder /reviewer notes");
    });

    it("keeps a slash word the model does not have", () => {
      expect(draftWithInvocation("/deploy now", "/review", [])).toBe("/review /deploy now");
    });
  });
});
