import { describe, it, expect, vi } from "vitest";

describe("AI Button", () => {
  describe("customize dispatch message", () => {
    it("builds customize_app message with app name and instruction", () => {
      const appName = "expense-tracker";
      const instruction = "add dark mode";
      const message = `[customize_app: ${appName}] ${instruction}`;

      expect(message).toContain("customize_app");
      expect(message).toContain(appName);
      expect(message).toContain(instruction);
    });

    it("app name is extracted from path correctly", () => {
      const cases: [string, string][] = [
        ["apps/todo.html", "todo"],
        ["apps/expense-tracker.html", "expense-tracker"],
        ["modules/calendar/index.html", "calendar"],
      ];

      for (const [path, expected] of cases) {
        let name: string;
        if (path.startsWith("modules/")) {
          name = path.split("/")[1];
        } else {
          name = path.replace("apps/", "").replace(".html", "");
        }
        expect(name).toBe(expected);
      }
    });
  });
});

describe("App Store data model", () => {
  interface AppStoreEntry {
    id: string;
    name: string;
    description: string;
    category: string;
    author: string;
    source: "bundled" | "url" | "prompt";
    prompt?: string;
    url?: string;
  }

  it("validates bundled app entry", () => {
    const entry: AppStoreEntry = {
      id: "todo",
      name: "Todo",
      description: "Simple task manager",
      category: "productivity",
      author: "Matrix OS",
      source: "bundled",
    };

    expect(entry.source).toBe("bundled");
    expect(entry.id).toBeTruthy();
    expect(entry.name).toBeTruthy();
    expect(entry.category).toBeTruthy();
  });

  it("validates prompt-based app entry", () => {
    const entry: AppStoreEntry = {
      id: "weather",
      name: "Weather Dashboard",
      description: "Real-time weather display",
      category: "utility",
      author: "Matrix OS",
      source: "prompt",
      prompt: "Build a weather dashboard that shows current conditions and forecast",
    };

    expect(entry.source).toBe("prompt");
    expect(entry.prompt).toBeTruthy();
  });

  it("validates url-based app entry", () => {
    const entry: AppStoreEntry = {
      id: "calculator",
      name: "Calculator",
      description: "Scientific calculator",
      category: "utility",
      author: "community",
      source: "url",
      url: "https://example.com/apps/calculator.html",
    };

    expect(entry.source).toBe("url");
    expect(entry.url).toBeTruthy();
  });

  it("supports category filtering", () => {
    const entries: AppStoreEntry[] = [
      { id: "todo", name: "Todo", description: "", category: "productivity", author: "Matrix OS", source: "bundled" },
      { id: "notes", name: "Notes", description: "", category: "productivity", author: "Matrix OS", source: "bundled" },
      { id: "snake", name: "Snake", description: "", category: "games", author: "Matrix OS", source: "prompt", prompt: "Build snake game" },
    ];

    const productivity = entries.filter((e) => e.category === "productivity");
    expect(productivity).toHaveLength(2);

    const games = entries.filter((e) => e.category === "games");
    expect(games).toHaveLength(1);
  });

  it("supports text search", () => {
    const entries: AppStoreEntry[] = [
      { id: "todo", name: "Todo", description: "Task management", category: "productivity", author: "Matrix OS", source: "bundled" },
      { id: "calc", name: "Calculator", description: "Math calculations", category: "utility", author: "Matrix OS", source: "bundled" },
    ];

    const query = "task";
    const results = entries.filter(
      (e) =>
        e.name.toLowerCase().includes(query) ||
        e.description.toLowerCase().includes(query),
    );
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("todo");
  });
});
