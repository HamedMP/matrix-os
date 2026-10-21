import type { ReactNode } from "react";
import { Linking, Text, View, type TextStyle, type ViewStyle } from "react-native";

import { FadeInText } from "@/lib/chat-fade-in-text";
import type { TextFade } from "@/lib/chat-text-fade";

export interface ChatMarkdownTheme {
  textStyle: TextStyle;
  mutedColor: string;
  linkColor: string;
  codeBackground: string;
  codeBorderColor: string;
  monoFontFamily: string;
  boldFontFamily: string;
  headingFontFamily: string;
}

const INLINE_RE = /(\*\*(.+?)\*\*|~~(.+?)~~|\*(.+?)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;

export function isSafeChatLink(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:";
  } catch (error: unknown) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

/**
 * Wraps the parts of `text` that are still fading in. `offset` is where `text`
 * starts in the message, which is what the fades are measured in. Text before
 * the first fade has settled and stays a plain string.
 */
export function fadeInSpans(text: string, offset: number, fades: TextFade[]): ReactNode {
  const end = offset + text.length;
  const firstFade = fades[0];
  if (!firstFade || end <= firstFade.from) return text;

  const nodes: ReactNode[] = [];
  if (offset < firstFade.from) nodes.push(text.slice(0, firstFade.from - offset));
  fades.forEach((fade, index) => {
    const from = Math.max(fade.from, offset);
    const to = Math.min(fades[index + 1]?.from ?? end, end);
    if (from >= to) return;
    nodes.push(
      <FadeInText key={fade.from} revealedAt={fade.revealedAt}>
        {text.slice(from - offset, to - offset)}
      </FadeInText>,
    );
  });
  return nodes;
}

/**
 * Inline spans only (bold/strikethrough/italic/code/link). Pure function of
 * `text` -- called fresh on every render with whatever text currently
 * exists, so a growing streamed string re-renders progressively instead of
 * waiting for the message to finish before markdown applies.
 *
 * `offset` is where `text` starts in the whole message: `fades` are measured
 * in message offsets, and markdown syntax (`**`, list markers, ...) means a
 * rendered piece rarely starts where its line does.
 */
function inlineNodes(
  text: string,
  keyPrefix: string,
  theme: ChatMarkdownTheme,
  offset: number,
  fades: TextFade[],
): ReactNode[] {
  const elements: ReactNode[] = [];
  /** The visible text starting at `index` in `text`, with its still-fading parts wrapped. */
  const piece = (value: string, index: number) => fadeInSpans(value, offset + index, fades);
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = INLINE_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      elements.push(
        <Text key={`${keyPrefix}-pre${lastIndex}`} style={theme.textStyle}>
          {piece(text.slice(lastIndex, match.index), lastIndex)}
        </Text>,
      );
    }
    if (match[2] !== undefined) {
      elements.push(
        <Text key={`${keyPrefix}-tok${match.index}`} style={[theme.textStyle, { fontFamily: theme.boldFontFamily }]}>
          {piece(match[2], match.index + 2)}
        </Text>,
      );
    } else if (match[3] !== undefined) {
      elements.push(
        <Text
          key={`${keyPrefix}-tok${match.index}`}
          style={[theme.textStyle, { textDecorationLine: "line-through", color: theme.mutedColor }]}
        >
          {piece(match[3], match.index + 2)}
        </Text>,
      );
    } else if (match[4] !== undefined) {
      elements.push(
        <Text key={`${keyPrefix}-tok${match.index}`} style={[theme.textStyle, { fontStyle: "italic" }]}>
          {piece(match[4], match.index + 1)}
        </Text>,
      );
    } else if (match[5] !== undefined) {
      elements.push(
        <Text
          key={`${keyPrefix}-tok${match.index}`}
          style={[
            theme.textStyle,
            {
              fontFamily: theme.monoFontFamily,
              fontSize: 13,
              backgroundColor: theme.codeBackground,
            },
          ]}
        >
          {piece(match[5], match.index + 1)}
        </Text>,
      );
    } else if (match[6] !== undefined && match[7] !== undefined) {
      const url = match[7];
      const safe = isSafeChatLink(url);
      elements.push(
        <Text
          key={`${keyPrefix}-tok${match.index}`}
          style={safe ? [theme.textStyle, { color: theme.linkColor, textDecorationLine: "underline" }] : theme.textStyle}
          {...(safe ? { onPress: () => void Linking.openURL(url) } : {})}
        >
          {piece(match[6], match.index + 1)}
        </Text>,
      );
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    elements.push(
      <Text key={`${keyPrefix}-tail${lastIndex}`} style={theme.textStyle}>
        {piece(text.slice(lastIndex), lastIndex)}
      </Text>,
    );
  }
  return elements;
}

const HEADING_RE = /^(#{1,6})\s+(.*)/;
const ORDERED_RE = /^(\s*)(\d+)\.\s+(.*)/;
const UNORDERED_RE = /^(\s*)[-*+]\s+(.*)/;
const BLOCKQUOTE_RE = /^>\s?(.*)/;
const RULE_RE = /^(?:-{3,}|\*{3,}|_{3,})$/;
const FENCE_RE = /^(```|~~~)(\S*)/;

const HEADING_SIZE: Record<number, number> = { 1: 22, 2: 19, 3: 17, 4: 15, 5: 14, 6: 13 };

function codeBlock(
  lines: string[],
  key: string,
  theme: ChatMarkdownTheme,
  offset: number,
  fades: TextFade[],
): ReactNode {
  const codeStyle: ViewStyle = {
    backgroundColor: theme.codeBackground,
    borderWidth: 1,
    borderColor: theme.codeBorderColor,
    borderRadius: 8,
    padding: 10,
    marginVertical: 4,
  };
  return (
    <View key={key} style={codeStyle}>
      <Text style={{ fontFamily: theme.monoFontFamily, fontSize: 12.5, color: theme.textStyle.color }}>
        {fadeInSpans(lines.join("\n"), offset, fades)}
      </Text>
    </View>
  );
}

/**
 * Block-level markdown -> RN nodes: fenced code blocks (```/~~~, including an
 * unclosed trailing fence mid-stream -- everything after it renders as code
 * until a close arrives), headings, blockquotes, ordered/unordered lists,
 * horizontal rules, and paragraphs of inline spans.
 *
 * `fades` marks the chunks of a streaming reply that are still fading in (see
 * `useStreamedTextReveal`); a settled message passes none.
 */
export function renderChatMarkdown(text: string, theme: ChatMarkdownTheme, fades: TextFade[] = []): ReactNode[] {
  const lines = text.split("\n");
  // Where each line starts in `text`, to translate positions back to message offsets.
  const lineOffsets: number[] = [];
  let nextLineOffset = 0;
  for (const line of lines) {
    lineOffsets.push(nextLineOffset);
    nextLineOffset += line.length + 1;
  }
  const blocks: ReactNode[] = [];
  let index = 0;
  let blockKey = 0;

  while (index < lines.length) {
    const line = lines[index]!;
    // Block syntax sits at the start of a line, so the content it captures is
    // always the line's tail.
    const lineEnd = lineOffsets[index]! + line.length;
    const tailOffset = (content: string) => lineEnd - content.length;
    const fence = line.match(FENCE_RE);
    if (fence) {
      const marker = fence[1];
      const codeLines: string[] = [];
      index += 1;
      const codeOffset = lineOffsets[index] ?? text.length;
      while (index < lines.length && lines[index] !== marker) {
        codeLines.push(lines[index]!);
        index += 1;
      }
      if (index < lines.length) index += 1; // consume closing fence
      blocks.push(codeBlock(codeLines, `code-${blockKey++}`, theme, codeOffset, fades));
      continue;
    }

    if (RULE_RE.test(line.trim())) {
      blocks.push(
        <View
          key={`rule-${blockKey++}`}
          style={{ height: 1, backgroundColor: theme.codeBorderColor, marginVertical: 8 }}
        />,
      );
      index += 1;
      continue;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      const level = heading[1]!.length;
      blocks.push(
        <Text
          key={`h-${blockKey++}`}
          style={[
            theme.textStyle,
            {
              fontFamily: theme.headingFontFamily,
              fontSize: HEADING_SIZE[level] ?? 14,
              marginTop: index > 0 ? 6 : 0,
              marginBottom: 2,
            },
          ]}
        >
          {inlineNodes(heading[2] ?? "", `h${blockKey}`, theme, tailOffset(heading[2] ?? ""), fades)}
        </Text>,
      );
      index += 1;
      continue;
    }

    const quote = line.match(BLOCKQUOTE_RE);
    if (quote) {
      blocks.push(
        <View
          key={`q-${blockKey++}`}
          style={{ flexDirection: "row", gap: 8, paddingLeft: 2 }}
        >
          <View style={{ width: 3, borderRadius: 2, backgroundColor: theme.codeBorderColor }} />
          <Text style={[theme.textStyle, { color: theme.mutedColor, flexShrink: 1 }]}>
            {inlineNodes(quote[1] ?? "", `q${blockKey}`, theme, tailOffset(quote[1] ?? ""), fades)}
          </Text>
        </View>,
      );
      index += 1;
      continue;
    }

    const ordered = line.match(ORDERED_RE);
    if (ordered) {
      const indent = ordered[1]?.length ?? 0;
      blocks.push(
        <Text key={`ol-${blockKey++}`} style={theme.textStyle}>
          <Text>{"  ".repeat(indent)}{ordered[2]}. </Text>
          {inlineNodes(ordered[3] ?? "", `ol${blockKey}`, theme, tailOffset(ordered[3] ?? ""), fades)}
        </Text>,
      );
      index += 1;
      continue;
    }

    const unordered = line.match(UNORDERED_RE);
    if (unordered) {
      const indent = unordered[1]?.length ?? 0;
      blocks.push(
        <Text key={`ul-${blockKey++}`} style={theme.textStyle}>
          <Text>{"  ".repeat(indent)}{"•  "}</Text>
          {inlineNodes(unordered[2] ?? "", `ul${blockKey}`, theme, tailOffset(unordered[2] ?? ""), fades)}
        </Text>,
      );
      index += 1;
      continue;
    }

    if (line.trim().length === 0) {
      blocks.push(<View key={`sp-${blockKey++}`} style={{ height: 6 }} />);
      index += 1;
      continue;
    }

    blocks.push(
      <Text key={`p-${blockKey++}`} style={theme.textStyle}>
        {inlineNodes(line, `p${blockKey}`, theme, tailOffset(line), fades)}
      </Text>,
    );
    index += 1;
  }

  return blocks;
}
