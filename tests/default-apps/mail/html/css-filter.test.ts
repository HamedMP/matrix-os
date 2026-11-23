import { describe, expect, it } from "vitest";
import { filterDeclarations, filterStylesheet } from "../../../../home/apps/mail/src/html/css-filter";

const style = (text: string) => filterDeclarations(text).css;

describe("filterDeclarations", () => {
  it("keeps allowed properties and normalises their spelling", () => {
    expect(style(" COLOR : Red ;  font-size:14PX;line-height : 1.5 ")).toBe("color:Red;font-size:14PX;line-height:1.5");
    expect(style("margin:0 auto;padding:8px 12px 8px 12px;border:1px solid #ddd")).toBe("margin:0 auto;padding:8px 12px 8px 12px;border:1px solid #ddd");
    expect(style("font-family:'Helvetica Neue', Arial, sans-serif")).toBe("font-family:'Helvetica Neue', Arial, sans-serif");
    expect(style("color:#fff!important")).toBe("color:#fff !important");
    expect(style("width:calc(100% - 20px);color:rgba(0, 0, 0, .5);background:linear-gradient(90deg, #fff, #eee)")).toBe(
      "width:calc(100% - 20px);color:rgba(0, 0, 0, .5);background:linear-gradient(90deg, #fff, #eee)",
    );
  });

  it("drops properties that are not on the allowlist", () => {
    expect(style("position:fixed;top:0;left:0;z-index:9999;color:red")).toBe("color:red");
    expect(style("position:absolute;position:sticky;position:relative")).toBe("position:relative");
    expect(style("behavior:url(x.htc);-moz-binding:url(x);-webkit-user-modify:read-write;color:red")).toBe("color:red");
    expect(style("content:'x';cursor:pointer;pointer-events:none;transform:scale(50);animation:x 1s;transition:all 1s;filter:blur(2px)")).toBe("");
    expect(style("--custom:red;color:var(--custom)")).toBe("");
  });

  it("drops values that load or run something", () => {
    expect(style("background-image:url(https://evil.example/t.png)")).toBe("");
    expect(style("list-style:url('x') inside")).toBe("");
    expect(style("width:expression(alert(1))")).toBe("");
    expect(style("background:image-set('a.png' 1x)")).toBe("");
    expect(style("color:red;background:javascript:alert(1)")).toBe("color:red");
    expect(style("font-family:x;src:url(a)")).toBe("font-family:x");
    expect(style("color:attr(data-x);width:env(safe-area-inset-left)")).toBe("");
  });

  it("removes the image from a background but keeps the rest", () => {
    expect(style("background:#fafafa url(https://cdn.example/a.png) no-repeat top left")).toBe("background:#fafafa no-repeat top left");
    expect(style("background: URL( \"a.png\" ) #000")).toBe("background:#000");
    expect(style("background:url(a.png)")).toBe("");
    expect(style("background:url(a.png")).toBe("");
  });

  it("treats escapes, comments and stray syntax as hostile", () => {
    expect(style("background:\\75\\72\\6c(x)")).toBe("");
    expect(style("c\\6flor:red;color:blue")).toBe("color:blue");
    expect(style("background:u/**/rl(x);color:red")).toBe("color:red");
    expect(style("color:red/* ; position:fixed */;width:1px")).toBe("color:red;width:1px");
    expect(style("color:red;}</style><script>alert(1)</script>")).toBe("color:red");
    expect(style("color:red{};width:<1px>")).toBe("");
    expect(style("@import 'x.css';color:red")).toBe("color:red");
    expect(style("color:red;;;:;width;height:")).toBe("color:red");
    expect(style("font-family:'a;position:fixed;b';color:red")).toBe("color:red");
    expect(style("font-family:'Segoe UI', \"Noto Sans\";color:red")).toBe("font-family:'Segoe UI', \"Noto Sans\";color:red");
    expect(style("font-family:'unterminated;color:red")).toBe("");
  });

  it("reports whether the style sets colours", () => {
    expect(filterDeclarations("margin:0").hasColor).toBe(false);
    expect(filterDeclarations("color:#000").hasColor).toBe(true);
    expect(filterDeclarations("background:#fff").hasColor).toBe(true);
    expect(filterDeclarations("background-color:transparent").hasColor).toBe(false);
    expect(filterDeclarations("color:inherit").hasColor).toBe(false);
    expect(filterDeclarations("position:fixed;color:red").hasColor).toBe(true);
  });

  it("bounds what it will process", () => {
    expect(style(`color:red;${"margin:0;".repeat(5000)}`).length).toBeLessThan(5000);
    expect(style(`width:${"1".repeat(600)}px`)).toBe("");
  });
});

describe("filterStylesheet", () => {
  const sheet = (text: string) => filterStylesheet(text).css;

  it("keeps simple rules with their safe declarations", () => {
    expect(sheet("p { color: red; position: fixed } .a, .b > td:first-child { padding: 4px }")).toBe("p{color:red}.a, .b > td:first-child{padding:4px}");
    expect(sheet("a:hover{text-decoration:underline} td[align=center]{text-align:center} #main .x{margin:0}")).toBe(
      "a:hover{text-decoration:underline}td[align=center]{text-align:center}#main .x{margin:0}",
    );
  });

  it("retargets html and body at the wrapper", () => {
    expect(sheet("body{margin:0} html, body { height: 100% } body.dark td, tbody td{color:#fff} .body{margin:1px}")).toBe(
      ".mx-body{margin:0}.mx-body, .mx-body{height:100%}.mx-body.dark td, tbody td{color:#fff}.body{margin:1px}",
    );
  });

  it("keeps media queries and drops every other at-rule", () => {
    expect(sheet("@media (max-width:600px){ .c{width:100% !important} @media print { .d{display:none} } }")).toBe(
      "@media (max-width:600px){.c{width:100% !important}@media print{.d{display:none}}}",
    );
    expect(sheet("@import url(x.css); @import 'y.css'; p{color:red}")).toBe("p{color:red}");
    expect(sheet("@font-face{font-family:x;src:url(f.woff)} @keyframes k{from{opacity:0}} @namespace svg url(x); @charset 'utf-8'; p{color:red}")).toBe("p{color:red}");
    expect(sheet("@supports (display:grid){p{color:red}} @page{margin:0} @media screen{@import 'x'; p{color:blue}}")).toBe("@media screen{p{color:blue}}");
    expect(sheet("@media screen and (min-width:url(x)){p{color:red}}")).toBe("");
  });

  it("drops rules whose selector is not plain", () => {
    expect(sheet("p\\3a x{color:red} q{color:blue}")).toBe("q{color:blue}");
    expect(sheet("a[href^='https://bank']{color:red} b{color:blue}")).toBe("b{color:blue}");
    expect(sheet(":root{color:red} *{margin:0} :host{display:none} ::selection{color:red} i{color:blue}")).toBe("*{margin:0}i{color:blue}");
    expect(sheet("p:has(> img){color:red} .mx-image-blocked{display:none} u{color:blue}")).toBe("u{color:blue}");
  });

  it("never emits markup, comments or unbalanced blocks", () => {
    expect(sheet("<!-- p{color:red} -->")).toBe("p{color:red}");
    expect(sheet("p{font-family:'</style><img src=x onerror=alert(1)>'} b{color:blue}")).toBe("b{color:blue}");
    expect(sheet("/* </style><script>alert(1)</script> */ p{color:red}")).toBe("p{color:red}");
    expect(sheet("p{color:red")).toBe("");
    expect(sheet("p{color:red}} b{color:blue}")).toBe("p{color:red}b{color:blue}");
    expect(sheet("}{}{ p{color:red}")).toBe("");
  });

  it("reports colours and bounds its output", () => {
    expect(filterStylesheet("p{margin:0}").hasColor).toBe(false);
    expect(filterStylesheet("@media screen{p{color:red}}").hasColor).toBe(true);
    expect(sheet("p{color:red}".repeat(50000)).length).toBeLessThanOrEqual(100_000);
  });
});
