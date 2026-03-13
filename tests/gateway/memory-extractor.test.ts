import { describe, it, expect } from "vitest";
import {
  extractMemoriesLocal,
  buildExtractionPrompt,
} from "../../packages/gateway/src/memory-extractor.js";

describe("memory extractor", () => {
  describe("extractMemoriesLocal (enhanced regex)", () => {
    it("extracts preferences with 'i prefer'", () => {
      const results = extractMemoriesLocal([
        { role: "user", content: "I prefer dark mode for all my apps" },
      ]);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].category).toBe("preference");
      expect(results[0].content).toContain("dark mode");
    });

    it("extracts preferences with 'i like'", () => {
      const results = extractMemoriesLocal([
        { role: "user", content: "I like using TypeScript for all projects" },
      ]);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].category).toBe("preference");
    });

    it("extracts instructions with 'always'", () => {
      const results = extractMemoriesLocal([
        { role: "user", content: "always test on docker before pushing" },
      ]);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].category).toBe("instruction");
    });

    it("extracts instructions with 'never'", () => {
      const results = extractMemoriesLocal([
        { role: "user", content: "never deploy on Fridays" },
      ]);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].category).toBe("instruction");
    });

    it("extracts instructions with 'remember that'", () => {
      const results = extractMemoriesLocal([
        { role: "user", content: "remember that the API key needs rotation monthly" },
      ]);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].category).toBe("instruction");
    });

    it("extracts facts about work/role", () => {
      const results = extractMemoriesLocal([
        { role: "user", content: "I work as a software engineer at Acme" },
      ]);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].category).toBe("fact");
      expect(results[0].content).toContain("software engineer");
    });

    it("extracts facts about name", () => {
      const results = extractMemoriesLocal([
        { role: "user", content: "My name is Alice" },
      ]);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].category).toBe("fact");
      expect(results[0].content).toContain("Alice");
    });

    it("extracts facts about location", () => {
      const results = extractMemoriesLocal([
        { role: "user", content: "I live in Stockholm" },
      ]);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].category).toBe("fact");
      expect(results[0].content).toContain("Stockholm");
    });

    it("extracts 'i usually' as preference", () => {
      const results = extractMemoriesLocal([
        { role: "user", content: "I usually work late on Thursdays" },
      ]);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].category).toBe("preference");
    });

    it("extracts 'don't' as instruction", () => {
      const results = extractMemoriesLocal([
        { role: "user", content: "Don't add emojis to my code" },
      ]);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].category).toBe("instruction");
    });

    it("extracts 'my email is' as fact", () => {
      const results = extractMemoriesLocal([
        { role: "user", content: "My email is alice@example.com" },
      ]);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].category).toBe("fact");
      expect(results[0].content).toContain("alice@example.com");
    });

    it("extracts 'i use' as fact", () => {
      const results = extractMemoriesLocal([
        { role: "user", content: "I use VS Code for development" },
      ]);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].category).toBe("fact");
    });

    it("ignores assistant messages", () => {
      const results = extractMemoriesLocal([
        { role: "assistant", content: "I prefer to help you with code" },
      ]);
      expect(results.length).toBe(0);
    });

    it("extracts multiple memories from multi-message conversations", () => {
      const results = extractMemoriesLocal([
        { role: "user", content: "My name is Bob" },
        { role: "assistant", content: "Nice to meet you Bob!" },
        { role: "user", content: "I prefer TypeScript over JavaScript" },
        { role: "assistant", content: "Noted!" },
        { role: "user", content: "I work as a DevOps engineer" },
      ]);
      expect(results.length).toBeGreaterThanOrEqual(3);
    });

    it("strips trailing punctuation from extracted content", () => {
      const results = extractMemoriesLocal([
        { role: "user", content: "My name is Charlie." },
      ]);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).not.toMatch(/[.!?]$/);
    });

    it("returns empty array for no matches", () => {
      const results = extractMemoriesLocal([
        { role: "user", content: "What time is it?" },
      ]);
      expect(results.length).toBe(0);
    });

    it("returns empty array for empty input", () => {
      expect(extractMemoriesLocal([]).length).toBe(0);
    });
  });

  describe("buildExtractionPrompt", () => {
    it("builds a prompt for LLM memory extraction", () => {
      const prompt = buildExtractionPrompt([
        { role: "user", content: "Add wash dishes to my todo" },
        { role: "assistant", content: "Added 'wash dishes' to your todo list." },
        { role: "user", content: "I usually do chores on Saturdays" },
      ]);
      expect(prompt).toContain("Extract");
      expect(prompt).toContain("wash dishes");
      expect(prompt).toContain("Saturdays");
    });

    it("includes category instructions in prompt", () => {
      const prompt = buildExtractionPrompt([
        { role: "user", content: "Hello" },
      ]);
      expect(prompt).toContain("fact");
      expect(prompt).toContain("preference");
      expect(prompt).toContain("instruction");
    });

    it("truncates long messages", () => {
      const longContent = "x".repeat(1000);
      const prompt = buildExtractionPrompt([
        { role: "user", content: longContent },
      ]);
      expect(prompt.length).toBeLessThan(2000);
    });

    it("limits to last 20 messages", () => {
      const messages = Array.from({ length: 30 }, (_, i) => ({
        role: (i % 2 === 0 ? "user" : "assistant") as string,
        content: `Message number ${i}`,
      }));
      const prompt = buildExtractionPrompt(messages);
      expect(prompt).toContain("Message number 29");
      expect(prompt).not.toContain("Message number 0");
    });

    it("asks for JSON array output", () => {
      const prompt = buildExtractionPrompt([
        { role: "user", content: "test" },
      ]);
      expect(prompt).toContain("JSON");
    });
  });
});
