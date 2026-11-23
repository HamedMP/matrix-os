import { describe, expect, it } from "vitest";
import { filterStylesheet } from "../../../../home/apps/mail/src/html/css-filter";
import { mediaQueryMatches, resolveMediaQueries } from "../../../../home/apps/mail/src/html/media-queries";

const narrow = { width: 380, deviceWidth: 1440, scheme: "light" as const };
const wide = { width: 700, deviceWidth: 1440, scheme: "dark" as const };

describe("mediaQueryMatches", () => {
  it("answers width queries with the frame's width", () => {
    expect(mediaQueryMatches("(max-width:600px)", narrow)).toBe(true);
    expect(mediaQueryMatches("(max-width:600px)", wide)).toBe(false);
    expect(mediaQueryMatches("only screen and (max-width: 600px)", narrow)).toBe(true);
    expect(mediaQueryMatches("screen and (min-width: 30em) and (max-width: 50em)", wide)).toBe(true);
    expect(mediaQueryMatches("screen and (min-width: 30em) and (max-width: 50em)", narrow)).toBe(false);
    expect(mediaQueryMatches("(min-width: 0)", narrow)).toBe(true);
  });

  it("answers device width, colour scheme, media types, lists and negation", () => {
    expect(mediaQueryMatches("(max-device-width: 480px)", narrow)).toBe(false);
    expect(mediaQueryMatches("(min-device-width: 1024px)", narrow)).toBe(true);
    expect(mediaQueryMatches("(prefers-color-scheme: dark)", wide)).toBe(true);
    expect(mediaQueryMatches("(prefers-color-scheme: dark)", narrow)).toBe(false);
    expect(mediaQueryMatches("print", narrow)).toBe(false);
    expect(mediaQueryMatches("all", narrow)).toBe(true);
    expect(mediaQueryMatches("print, (max-width: 400px)", narrow)).toBe(true);
    expect(mediaQueryMatches("not screen", narrow)).toBe(false);
    expect(mediaQueryMatches("not print", narrow)).toBe(true);
    expect(mediaQueryMatches("not screen and (max-width: 600px)", wide)).toBe(true);
  });

  it("treats a query it cannot read as not matching", () => {
    expect(mediaQueryMatches("(orientation: portrait)", narrow)).toBe(false);
    expect(mediaQueryMatches("not (orientation: portrait)", narrow)).toBe(false);
    expect(mediaQueryMatches("(max-width: 10vw)", narrow)).toBe(false);
    expect(mediaQueryMatches("tv", narrow)).toBe(false);
    expect(mediaQueryMatches("", narrow)).toBe(false);
  });
});

describe("resolveMediaQueries", () => {
  const css = filterStylesheet(
    ".a{color:red} @media (max-width:600px){ .c{width:100% !important} @media (prefers-color-scheme: dark){ .d{color:#fff} } } .b{margin:0} @media print{.p{display:none}} @media screen and (min-width: 601px){.w{padding:4px}}",
  ).css;

  it("unwraps the blocks that match and drops the rest", () => {
    expect(resolveMediaQueries(css, narrow)).toBe(".a{color:red}.c{width:100% !important}.b{margin:0}");
    expect(resolveMediaQueries(css, wide)).toBe(".a{color:red}.b{margin:0}.w{padding:4px}");
    expect(resolveMediaQueries(css, { ...narrow, scheme: "dark" })).toBe(".a{color:red}.c{width:100% !important}.d{color:#fff}.b{margin:0}");
  });

  it("returns plain rules unchanged and never emits an at-rule", () => {
    expect(resolveMediaQueries(".a{color:red}.b{margin:0}", narrow)).toBe(".a{color:red}.b{margin:0}");
    expect(resolveMediaQueries("", narrow)).toBe("");
    expect(resolveMediaQueries("@import 'x';.a{color:red}@font-face{src:x}.b{margin:0}@media screen{.c{margin:0}", narrow)).not.toContain("@");
    expect(resolveMediaQueries(css, narrow)).not.toContain("@");
  });
});
