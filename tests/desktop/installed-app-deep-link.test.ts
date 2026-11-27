import { describe, expect, it, vi } from "vitest";
import {
  createInstalledAppDeepLinks,
  parseInstalledAppDeepLink,
} from "@desktop/main/installed-apps/deep-link";

const SCHEMES = ["matrixos", "matrix-os"] as const;
const ID = "6f1c2a4e-2b7d-4c1a-9f3e-1a2b3c4d5e6f";
const OTHER_ID = "0b6f7c8d-1e2f-4a3b-8c4d-5e6f7a8b9c0d";

describe("matrixos://app/<installId> parsing", () => {
  it.each([
    [`matrixos://app/${ID}`, ID],
    [`matrix-os://app/${ID}`, ID],
    [`matrixos://app/${ID.toUpperCase()}`, ID],
    [`matrixos://app/${ID}/`, ID],
  ])("accepts %s", (url, expected) => {
    expect(parseInstalledAppDeepLink(url, SCHEMES)).toBe(expected);
  });

  it.each([
    ["a folder-name id", "matrixos://app/notes"],
    ["a traversal id", "matrixos://app/..%2Fnotes"],
    ["a malformed UUID", "matrixos://app/6f1c2a4e-2b7d-4c1a-9f3e"],
    ["an extra path segment", `matrixos://app/${ID}/extra`],
    ["a missing id", "matrixos://app/"],
    ["another host", `matrixos://shared-app/${ID}`],
    ["the auth callback", "matrixos://auth?status=approved"],
    ["another scheme", `matrixos-canary://app/${ID}`],
    ["an https URL", `https://app/${ID}`],
    ["query parameters", `matrixos://app/${ID}?token=x`],
    ["a fragment", `matrixos://app/${ID}#x`],
    ["user info", `matrixos://user@app/${ID}`],
    ["a port", `matrixos://app:8080/${ID}`],
    ["a non-URL", "not a url"],
  ])("rejects %s", (_label, url) => {
    expect(parseInstalledAppDeepLink(url, SCHEMES)).toBeNull();
  });
});

describe("installed app deep links", () => {
  it("ignores links that are not installed-app links so other routers handle them", () => {
    const links = createInstalledAppDeepLinks({ schemes: SCHEMES });
    expect(links.handle("matrixos://shared-app/abc")).toBe(false);
    expect(links.handle("matrixos://app/notes")).toBe(true);
  });

  it("holds one link until the opener is ready, then opens only the latest", () => {
    const links = createInstalledAppDeepLinks({ schemes: SCHEMES });
    expect(links.handle(`matrixos://app/${ID}`)).toBe(true);
    expect(links.handle(`matrixos://app/${OTHER_ID}`)).toBe(true);
    const open = vi.fn();
    links.ready(open);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(OTHER_ID);
  });

  it("opens directly once ready and holds again after the opener detaches", () => {
    const links = createInstalledAppDeepLinks({ schemes: SCHEMES });
    const open = vi.fn();
    links.ready(open);
    links.handle(`matrixos://app/${ID}`);
    expect(open).toHaveBeenCalledWith(ID);
    links.detach();
    links.handle(`matrixos://app/${OTHER_ID}`);
    expect(open).toHaveBeenCalledTimes(1);
    const reopened = vi.fn();
    links.ready(reopened);
    expect(reopened).toHaveBeenCalledWith(OTHER_ID);
  });

  it("consumes an invalid installed-app link without opening anything", () => {
    const links = createInstalledAppDeepLinks({ schemes: SCHEMES });
    const open = vi.fn();
    links.ready(open);
    expect(links.handle("matrixos://app/../../etc")).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });
});
