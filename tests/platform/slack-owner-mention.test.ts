import { describe, expect, it } from "vitest";
import { hasActiveSlackUserMention } from "../../packages/platform/src/slack/owner-mention.js";

const target = "U123";
const user = (userId = target, style?: object) => ({ type: "user", user_id: userId, ...(style && { style }) });
const section = (...elements: unknown[]) => ({ type: "rich_text_section", elements });
const rich = (...elements: unknown[]) => [{ type: "rich_text", elements }];
const mention = (text: string, blocks?: unknown) => hasActiveSlackUserMention({ text, ...(blocks !== undefined && { blocks }) }, target);

describe("active Slack owner mention", () => {
  it.each(["<@U123>", "你好 👋 <@U123> 请看", "<@U456> and <@U123>", "before\n<@U123>", "`quoted` then <@U123>", "> quote\n<@U123>", "```code``` <@U123>"])
  ("matches actual exact mentions in text: %j", text => expect(mention(text)).toBe(true));

  it.each(["Yuhan", "@U123", "<@U1234>", "<@U456>", "<@u123>", "<@U123|Yuhan>", "＜@U123＞", "&lt;@U123&gt;", "\\<@U123>", "`<@U123>`", "```\n<@U123>\n```", "`unclosed <@U123>", "> <@U123>", "  > <@U123>", ">>> quote\n<@U123>", "<https://example.com|<@U123>>", "<https://example.com/@U123|Yuhan>", "<mailto:test@example.com|@U123>"])
  ("does not promote inert/lookalike text: %j", text => expect(mention(text)).toBe(false));

  it("accepts W user IDs and rejects malformed target IDs", () => {
    expect(hasActiveSlackUserMention({ text: "<@W123>" }, "W123")).toBe(true);
    for (const id of ["", "U1", "B123", "U123>", "U12 3", "u123", "U" + "1".repeat(64)]) {
      expect(hasActiveSlackUserMention({ text: `<@${id}>` }, id)).toBe(false);
    }
  });

  it("matches structured users in sections and lists, including styled and multiple users", () => {
    expect(mention("fallback", rich(section({ type: "text", text: "你好 " }, user("U456"), user(target, { bold: true }))))).toBe(true);
    expect(mention("fallback", rich({ type: "rich_text_list", style: "bullet", indent: 1, elements: [section(user(target, { bold: true }))] }))).toBe(true);
    expect(mention("fallback", rich({ type: "rich_text_list", style: "ordered", elements: [section(user(target, { italic: true }))] }))).toBe(true);
  });

  it.each([
    rich(section(user("U456"))),
    rich(section({ type: "text", text: "<@U123>" })),
    rich(section({ type: "link", url: "https://example.com", text: "<@U123>" })),
    rich(section(user(target, { code: true }))),
    rich({ type: "rich_text_quote", elements: [user()] }),
    rich({ type: "rich_text_preformatted", elements: [user()] }),
    [], null, {}, [{ type: "section", text: { type: "mrkdwn", text: "<@U123>" } }],
    rich({ type: "unknown", elements: [section(user())] }),
    rich(section({ type: "unknown", elements: [user()] })),
    rich(section({ type: "user", user_id: target, style: "code" })),
    rich(section({ type: "user", user_id: target, style: { code: "false" } })),
    rich(section({ type: "user", user_id: [target] })),
    rich(section({ type: "text", text: 12 })),
    rich({ type: "rich_text_section", elements: "bad" }),
    rich({ type: "rich_text_list", style: "unknown", elements: [section(user())] }),
    rich({ type: "rich_text_list", style: "bullet", elements: [user()] }),
  ].map(blocks => ({ blocks })))("does not fall back to mention text for inert or malformed blocks: %j", ({ blocks }) => {
    expect(mention("<@U123>", blocks)).toBe(false);
  });

  it("validates the complete structure before accepting an earlier active mention", () => {
    expect(mention("", rich(section(user()), section({ type: "unknown" })))).toBe(false);
    expect(mention("", [...rich(section(user())), { type: "unknown" }])).toBe(false);
  });

  it("does not let harmless rich text hide a real active user element", () => {
    expect(mention("", rich(
      { type: "rich_text_quote", elements: [user()] },
      { type: "rich_text_preformatted", elements: [{ type: "text", text: "literal" }] },
      section(
        { type: "emoji", name: "wave" }, { type: "channel", channel_id: "C123" },
        { type: "usergroup", usergroup_id: "S123" }, { type: "broadcast", range: "here" },
        { type: "link", url: "https://example.com" }, user(target, { code: false }),
      ),
    ))).toBe(true);
  });

  it.each([
    [{ type: "rich_text", elements: null }], [null],
    rich(null), rich(section(null)), rich(section({ type: "user", user_id: "invalid" })),
    rich(section({ type: "link", url: 1 })), rich(section({ type: "emoji", name: 1 })),
    rich(section({ type: "channel", channel_id: null })), rich(section({ type: "usergroup", usergroup_id: null })),
    rich(section({ type: "broadcast", range: "all" })),
    rich({ type: "rich_text_list", style: "bullet", indent: -1, elements: [section(user())] }),
  ].map(blocks => ({ blocks })))("rejects malformed known rich text nodes: %j", ({ blocks }) => expect(mention("<@U123>", blocks)).toBe(false));

  it("keeps open code across newlines and keeps escaped/nested links inert", () => {
    expect(mention("```\n> quote marker\n<@U123>\n```\n<@U456>")).toBe(false);
    expect(mention("``code <@U123>`` <@U123>")).toBe(true);
    expect(mention("\\<https://example.com|<@U123>>")).toBe(false);
    expect(mention("<https://example.com|<@U456>> then <@U123>")).toBe(true);
    expect(mention("<https://example.com|unclosed <@U123>")).toBe(false);
    expect(mention("plain >>> text <@U123>")).toBe(true);
    expect(mention("<@U123>\n>>> later quoted text")).toBe(true);
    expect(mention("x".repeat(39_993) + "<@U123>")).toBe(true);
    expect(mention("\\*emphasis* <@U123>")).toBe(true);
    expect(mention("``` unmatched ` tick <@U123> ```")).toBe(false);
  });

  it("bounds fallback text and structured data, including unrelated nested fields", () => {
    expect(mention("x".repeat(40_001) + "<@U123>")).toBe(false);
    expect(mention("x".repeat(40_001), rich(section(user())))).toBe(false);
    expect(mention("", rich(section({ type: "text", text: "x".repeat(40_001) }, user())))).toBe(false);
    expect(mention("", Array.from({ length: 51 }, () => rich(section(user()))[0]))).toBe(false);
    expect(mention("", rich(section(...Array.from({ length: 1_025 }, () => user()))))).toBe(false);
    let nested: unknown = user();
    for (let i = 0; i < 20; i++) nested = { extra: nested };
    expect(mention("", [{ ...rich(section(user()))[0], extra: nested }])).toBe(false);
    const cyclic: Record<string, unknown> = { type: "rich_text", elements: [section(user())] };
    cyclic.extra = cyclic;
    expect(mention("", [cyclic])).toBe(false);
    expect(mention("", [{ ...rich(section(user()))[0], extra: Array.from({ length: 1_025 }, () => null) }])).toBe(false);
    expect(mention("", [{ ...rich(section(user()))[0], extra: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [i, true])) }])).toBe(false);
    expect(mention("", [{ ...rich(section(user()))[0], extra: Number.NaN }])).toBe(false);
    expect(mention("", [{ ...rich(section(user()))[0], extra: undefined }])).toBe(false);
    expect(mention("", [{ ...rich(section(user()))[0], extra: "x".repeat(39_990) }])).toBe(false);
    const inherited = Object.assign(Object.create({ ignored: true }), rich(section(user()))[0]);
    expect(mention("", [inherited])).toBe(true);
    expect(mention("", rich({ type: "rich_text_list", style: "bullet", elements: [section({ type: "unknown" })] }))).toBe(false);
  });

  it("retains text fallback only when blocks are absent", () => {
    expect(hasActiveSlackUserMention({ text: "<@U123>" }, target)).toBe(true);
    expect(hasActiveSlackUserMention({ text: "<@U123>", blocks: undefined }, target)).toBe(false);
  });
});
