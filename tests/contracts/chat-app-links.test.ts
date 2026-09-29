import { expect, it } from "vitest";
import { resolveChatAppReference } from "../../packages/contracts/src/chat-links";

const apps = [
  { slug: "ai-adoption", name: "AI Adoption", path: "apps/ai-adoption/index.html" },
  { slug: "chess", name: "Chess", path: "apps/games/chess/index.html" },
];

it("resolves owner app directories and entries against the installed catalog", () => {
  for (const path of ["apps/ai-adoption", "~/apps/ai-adoption/", "/home/matrix/home/apps/ai-adoption", "apps/ai-adoption/index.html", "apps/ai-adoption/dist/index.html"]) {
    expect(resolveChatAppReference(path, apps)).toBe(apps[0]);
  }
  expect(resolveChatAppReference("apps/games/chess", apps)).toBe(apps[1]);
});

it("does not launch source files, unknown folders, or paths outside the owner root", () => {
  for (const path of ["apps/ai-adoption/src/App.tsx", "apps/ai-adoption/chart.png", "apps/unknown", "apps/ai-adoption/../chess", "/private/apps/ai-adoption", "https://example.com/apps/ai-adoption", "ai-adoption"]) {
    expect(resolveChatAppReference(path, apps)).toBeNull();
  }
  expect(resolveChatAppReference("apps/ai-adoption", [])).toBeNull();
});

it("does not reinterpret a project's relative apps directory as an installed home app", () => {
  expect(resolveChatAppReference("apps/ai-adoption", apps, { allowRelative: false })).toBeNull();
  expect(resolveChatAppReference("./apps/ai-adoption/index.html", apps, { allowRelative: false })).toBeNull();
  expect(resolveChatAppReference("~/apps/ai-adoption", apps, { allowRelative: false })).toBe(apps[0]);
  expect(resolveChatAppReference("/home/matrix/home/apps/ai-adoption", apps, { allowRelative: false })).toBe(apps[0]);
});

it("recognizes the installed Browser catalog alias without launching other built-ins", () => {
  const browser = { slug: "browser", path: "__browser__" };
  for (const path of ["~/apps/browser", "apps/browser/index.html", "apps/browser/dist/index.html"]) {
    expect(resolveChatAppReference(path, [browser])).toBe(browser);
  }
  expect(resolveChatAppReference("apps/terminal", [{ slug: "terminal", path: "__terminal__" }])).toBeNull();
});
