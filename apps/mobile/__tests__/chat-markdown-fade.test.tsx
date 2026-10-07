import { render } from "@testing-library/react-native";
import { Text } from "react-native";

import { fadeInSpans, renderChatMarkdown, type ChatMarkdownTheme } from "../lib/chat-markdown";
import { FadeInText } from "../lib/chat-fade-in-text";

const theme: ChatMarkdownTheme = {
  textStyle: { fontSize: 15, color: "#000" },
  mutedColor: "#666",
  linkColor: "#00f",
  codeBackground: "#eee",
  codeBorderColor: "#ccc",
  monoFontFamily: "mono",
  boldFontFamily: "bold",
  headingFontFamily: "heading",
};

/** The text of every span that is fading in, in reading order. */
function fadingText(nodes: React.ReactNode): string[] {
  const view = render(<Text>{nodes}</Text>);
  return view.UNSAFE_queryAllByType(FadeInText).map((node) => node.props.children as string);
}

describe("fadeInSpans", () => {
  it("returns the text untouched when no fade reaches it", () => {
    expect(fadeInSpans("hello world", 0, [])).toBe("hello world");
    expect(fadeInSpans("hello world", 0, [{ from: 11, revealedAt: 0 }])).toBe("hello world");
  });

  it("splits the text where each fade begins", () => {
    // "hello world" sits at source offsets 10..21.
    const fades = [{ from: 16, revealedAt: 0 }, { from: 19, revealedAt: 40 }];

    expect(fadingText(fadeInSpans("hello world", 10, fades))).toEqual(["wor", "ld"]);
  });
});

describe("renderChatMarkdown with fades", () => {
  it("renders nothing as fading when there are no fades", () => {
    expect(fadingText(renderChatMarkdown("Intro\n- item **bold** end", theme))).toEqual([]);
  });

  it("maps source offsets through block and inline syntax", () => {
    // Line 2 starts at offset 11; "bold" sits at 20..24 and " end" at 26..30.
    const text = "Intro line\n- item **bold** end";

    expect(fadingText(renderChatMarkdown(text, theme, [{ from: 22, revealedAt: 0 }]))).toEqual(["ld", " end"]);
  });

  it("fades code inside a fenced block", () => {
    // The code starts at offset 6, right after the "```ts\n" fence line.
    const text = "```ts\nconst a = 1;\nconst b = 2;";

    expect(fadingText(renderChatMarkdown(text, theme, [{ from: 19, revealedAt: 0 }]))).toEqual(["const b = 2;"]);
  });
});
