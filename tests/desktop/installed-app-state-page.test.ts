import { describe, expect, it } from "vitest";
import {
  INSTALLED_APP_ACTION_URLS,
  installedAppAction,
  installedAppStatePage,
} from "@desktop/main/installed-apps/state-page";

function decode(dataUrl: string): string {
  expect(dataUrl.startsWith("data:text/html;charset=utf-8,")).toBe(true);
  return decodeURIComponent(dataUrl.slice("data:text/html;charset=utf-8,".length));
}

describe("installed app state page", () => {
  it("names the app in each state without running scripts", () => {
    const signedOut = decode(installedAppStatePage("signed-out", "Notes"));
    expect(signedOut).toContain("Sign in to Matrix to open Notes");
    expect(signedOut).toContain(`href="${INSTALLED_APP_ACTION_URLS.openMatrix}"`);
    for (const kind of ["loading", "signed-out", "missing", "unavailable"] as const) {
      const html = decode(installedAppStatePage(kind, "Notes"));
      expect(html).toContain("default-src 'none'");
      expect(html).not.toMatch(/<script/i);
    }
    expect(decode(installedAppStatePage("missing", "Notes"))).toContain(`href="${INSTALLED_APP_ACTION_URLS.retry}"`);
    expect(decode(installedAppStatePage("unavailable", "Notes"))).toContain("App can&#39;t open right now");
  });

  it("escapes the owner-controlled app name", () => {
    const html = decode(installedAppStatePage("signed-out", `<img src=x onerror="alert(1)">&`));
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;");
  });

  it("recognizes only its exact action URLs", () => {
    expect(installedAppAction(INSTALLED_APP_ACTION_URLS.retry)).toBe("retry");
    expect(installedAppAction(INSTALLED_APP_ACTION_URLS.openMatrix)).toBe("open-matrix");
    expect(installedAppAction(`${INSTALLED_APP_ACTION_URLS.retry}?x=1`)).toBeNull();
    expect(installedAppAction("https://installed-app.matrix-os.invalid.evil.test/retry")).toBeNull();
    expect(installedAppAction("not a url")).toBeNull();
  });
});
