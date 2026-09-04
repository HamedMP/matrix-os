import type { ReactNode } from "react";
import { Linking, Text, View, type TextStyle, type ViewStyle } from "react-native";

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

/**
 * Inline spans only (bold/strikethrough/italic/code/link). Pure function of
 * `text` -- called fresh on every render with whatever text currently
 * exists, so a growing streamed string re-renders progressively instead of
 * waiting for the message to finish before markdown applies.
 */
function inlineNodes(text: string, keyPrefix: string, theme: ChatMarkdownTheme): ReactNode[] {
  const elements: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = INLINE_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      elements.push(
        <Text key={`${keyPrefix}-pre${lastIndex}`} style={theme.textStyle}>
          {text.slice(lastIndex, match.index)}
        </Text>,
      );
    }
    if (match[2] !== undefined) {
      elements.push(
        <Text key={`${keyPrefix}-tok${match.index}`} style={[theme.textStyle, { fontFamily: theme.boldFontFamily }]}>
          {match[2]}
        </Text>,
      );
    } else if (match[3] !== undefined) {
      elements.push(
        <Text
          key={`${keyPrefix}-tok${match.index}`}
          style={[theme.textStyle, { textDecorationLine: "line-through", color: theme.mutedColor }]}
        >
          {match[3]}
        </Text>,
      );
    } else if (match[4] !== undefined) {
      elements.push(
        <Text key={`${keyPrefix}-tok${match.index}`} style={[theme.textStyle, { fontStyle: "italic" }]}>
          {match[4]}
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
          {match[5]}
        </Text>,
      );
    } else if (match[6] !== undefined && match[7] !== undefined) {
      const url = match[7];
      elements.push(
        <Text
          key={`${keyPrefix}-tok${match.index}`}
          style={[theme.textStyle, { color: theme.linkColor, textDecorationLine: "underline" }]}
          onPress={() => void Linking.openURL(url)}
        >
          {match[6]}
        </Text>,
      );
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    elements.push(
      <Text key={`${keyPrefix}-tail${lastIndex}`} style={theme.textStyle}>
        {text.slice(lastIndex)}
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

function codeBlock(lines: string[], key: string, theme: ChatMarkdownTheme): ReactNode {
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
        {lines.join("\n")}
      </Text>
    </View>
  );
}

/**
 * Block-level markdown -> RN nodes: fenced code blocks (```/~~~, including an
 * unclosed trailing fence mid-stream -- everything after it renders as code
 * until a close arrives), headings, blockquotes, ordered/unordered lists,
 * horizontal rules, and paragraphs of inline spans.
 */
export function renderChatMarkdown(text: string, theme: ChatMarkdownTheme): ReactNode[] {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  let blockKey = 0;

  while (index < lines.length) {
    const line = lines[index]!;
    const fence = line.match(FENCE_RE);
    if (fence) {
      const marker = fence[1];
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && lines[index] !== marker) {
        codeLines.push(lines[index]!);
        index += 1;
      }
      if (index < lines.length) index += 1; // consume closing fence
      blocks.push(codeBlock(codeLines, `code-${blockKey++}`, theme));
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
          {inlineNodes(heading[2] ?? "", `h${blockKey}`, theme)}
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
            {inlineNodes(quote[1] ?? "", `q${blockKey}`, theme)}
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
          {inlineNodes(ordered[3] ?? "", `ol${blockKey}`, theme)}
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
          {inlineNodes(unordered[2] ?? "", `ul${blockKey}`, theme)}
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
        {inlineNodes(line, `p${blockKey}`, theme)}
      </Text>,
    );
    index += 1;
  }

  return blocks;
}
