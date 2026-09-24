import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { buildBrowserPasswordFillScript } from "@desktop/main/browser/password-fill";

describe("user-initiated browser password fill", () => {
  it("fills a visible same-origin form without submitting it", () => {
    const dom = new JSDOM("<form><input name='email' type='email'><input type='password'></form>", {
      url: "https://example.com/login", runScripts: "outside-only",
    });
    const passwordInput = dom.window.document.querySelector("input[type=password]")!;
    const usernameInput = dom.window.document.querySelector("input[type=email]")!;
    passwordInput.getClientRects = () => ({ length: 1 }) as DOMRectList;
    usernameInput.getClientRects = () => ({ length: 1 }) as DOMRectList;
    let inputEvents = 0;
    passwordInput.addEventListener("input", () => inputEvents++);
    expect(dom.window.eval(buildBrowserPasswordFillScript("https://example.com", "alice", "secret"))).toBe(true);
    expect((dom.window.document.querySelector("input[type=email]") as HTMLInputElement).value).toBe("alice");
    expect((passwordInput as HTMLInputElement).value).toBe("secret");
    expect(inputEvents).toBe(1);
  });

  it("refuses a different origin or hidden password field", () => {
    const dom = new JSDOM("<form><input type='password'></form>", {
      url: "https://other.example/login", runScripts: "outside-only",
    });
    expect(dom.window.eval(buildBrowserPasswordFillScript("https://example.com", "alice", "secret"))).toBe(false);
    expect((dom.window.document.querySelector("input") as HTMLInputElement).value).toBe("");
    expect(dom.window.eval(buildBrowserPasswordFillScript("https://other.example", "alice", "secret"))).toBe(false);
  });
});
