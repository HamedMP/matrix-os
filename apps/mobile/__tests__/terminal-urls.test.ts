import {
  extractHttpUrls,
  isOpenableUrl,
  pickBannerUrl,
  pushRecentUrls,
} from "@/lib/terminal-urls";

describe("extractHttpUrls", () => {
  it("extracts http and https urls in order, preserving ports and queries", () => {
    expect(
      extractHttpUrls("Local: http://localhost:3000 and https://app.matrix-os.com/auth?token=abc123"),
    ).toEqual(["http://localhost:3000", "https://app.matrix-os.com/auth?token=abc123"]);
  });

  it("trims trailing sentence punctuation and wrapping brackets", () => {
    expect(extractHttpUrls("visit https://example.com/path.")).toEqual([
      "https://example.com/path",
    ]);
    expect(extractHttpUrls("see (https://example.com/x), now")).toEqual([
      "https://example.com/x",
    ]);
  });

  it("dedupes within one scan, preserving first-seen order", () => {
    expect(
      extractHttpUrls("http://a.test http://b.test http://a.test"),
    ).toEqual(["http://a.test", "http://b.test"]);
  });

  it("ignores non-http schemes and bare words", () => {
    expect(extractHttpUrls("ws://x wss://y ftp://z file:///a just text")).toEqual([]);
  });

  it("returns nothing for empty or non-url text", () => {
    expect(extractHttpUrls("")).toEqual([]);
    expect(extractHttpUrls("no links here")).toEqual([]);
  });
});

describe("pushRecentUrls", () => {
  it("appends new urls most-recent-last and enforces the cap", () => {
    let list: string[] = [];
    list = pushRecentUrls(list, ["http://a.test", "http://b.test"], 3);
    list = pushRecentUrls(list, ["http://c.test", "http://d.test"], 3);
    expect(list).toEqual(["http://b.test", "http://c.test", "http://d.test"]);
  });

  it("moves a re-detected url to most-recent without duplicating", () => {
    const list = pushRecentUrls(["http://a.test", "http://b.test"], ["http://a.test"], 5);
    expect(list).toEqual(["http://b.test", "http://a.test"]);
  });
});

describe("pickBannerUrl", () => {
  it("returns the most recent url not dismissed", () => {
    const recent = ["http://a.test", "http://b.test", "http://c.test"];
    expect(pickBannerUrl(recent, new Set(["http://c.test"]))).toBe("http://b.test");
    expect(pickBannerUrl(recent, new Set())).toBe("http://c.test");
    expect(pickBannerUrl(recent, new Set(recent))).toBeNull();
  });
});

describe("isOpenableUrl", () => {
  it("only allows https urls to open", () => {
    expect(isOpenableUrl("https://example.com")).toBe(true);
    expect(isOpenableUrl("http://localhost:3000")).toBe(false);
    expect(isOpenableUrl("javascript:alert(1)")).toBe(false);
  });
});
