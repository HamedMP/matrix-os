import { useCallback } from "react";
import { View, Text, ScrollView, Pressable, Image, Linking, StyleSheet } from "react-native";
import Animated, { FadeInLeft, FadeInRight } from "react-native-reanimated";
import * as Clipboard from "expo-clipboard";
import { Ionicons } from "@expo/vector-icons";
import { colors, fonts, spacing, radius } from "@/lib/theme";
import type { Message } from "@/app/(tabs)/chat";

const roleContainerStyles: Record<Message["role"], object> = {
  user: {
    backgroundColor: colors.light.primary,
    alignSelf: "flex-end" as const,
  },
  assistant: {
    backgroundColor: colors.light.card,
    borderWidth: 1,
    borderColor: colors.light.border,
    alignSelf: "flex-start" as const,
  },
  system: {
    backgroundColor: "rgba(239, 68, 68, 0.1)",
    alignSelf: "center" as const,
  },
  tool: {
    backgroundColor: colors.light.secondary,
    alignSelf: "flex-start" as const,
  },
};

const roleTextStyles: Record<Message["role"], object> = {
  user: { color: colors.light.primaryForeground },
  assistant: { color: colors.light.cardForeground },
  system: { color: colors.light.destructive, fontSize: 12 },
  tool: { color: colors.light.mutedForeground, fontSize: 12, fontFamily: fonts.mono },
};

const timestampAlignStyles: Record<Message["role"], object> = {
  user: { alignSelf: "flex-end" as const },
  assistant: { alignSelf: "flex-start" as const },
  system: { alignSelf: "center" as const },
  tool: { alignSelf: "flex-start" as const },
};

const IMAGE_EXTENSIONS = /\.(png|jpg|jpeg|gif|webp|svg)$/i;

function renderMarkdown(text: string, baseStyle: object): React.ReactNode[] {
  const elements: React.ReactNode[] = [];
  const lines = text.split("\n");

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];

    if (li > 0) {
      elements.push(<Text key={`nl-${li}`}>{"\n"}</Text>);
    }

    // Bullet lists
    const bulletMatch = line.match(/^(\s*)[-*]\s+(.*)/);
    if (bulletMatch) {
      const indent = bulletMatch[1].length;
      const bulletContent = bulletMatch[2];
      elements.push(
        <Text key={`bullet-${li}`} style={baseStyle}>
          <Text>{"  ".repeat(indent) + "  \u2022  "}</Text>
          {renderInlineMarkdown(bulletContent, baseStyle, `b-${li}`)}
        </Text>,
      );
      continue;
    }

    elements.push(...renderInlineMarkdown(line, baseStyle, `l-${li}`));
  }

  return elements;
}

function renderInlineMarkdown(
  text: string,
  baseStyle: object,
  keyPrefix: string,
): React.ReactNode[] {
  const elements: React.ReactNode[] = [];
  // Match: **bold**, *italic*, `inline code`, [text](url)
  const inlineRe = /(\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
  let lastIndex = 0;
  let match;
  let idx = 0;

  while ((match = inlineRe.exec(text)) !== null) {
    // Text before match
    if (match.index > lastIndex) {
      elements.push(
        <Text key={`${keyPrefix}-t${idx}`} style={baseStyle}>
          {text.slice(lastIndex, match.index)}
        </Text>,
      );
      idx++;
    }

    if (match[2] !== undefined) {
      // Bold: **text**
      elements.push(
        <Text key={`${keyPrefix}-b${idx}`} style={[baseStyle, { fontFamily: fonts.sansBold }]}>
          {match[2]}
        </Text>,
      );
    } else if (match[3] !== undefined) {
      // Italic: *text*
      elements.push(
        <Text key={`${keyPrefix}-i${idx}`} style={[baseStyle, { fontStyle: "italic" }]}>
          {match[3]}
        </Text>,
      );
    } else if (match[4] !== undefined) {
      // Inline code: `code`
      elements.push(
        <Text
          key={`${keyPrefix}-c${idx}`}
          style={[
            baseStyle,
            {
              fontFamily: fonts.mono,
              fontSize: 13,
              backgroundColor: "rgba(28, 25, 23, 0.08)",
            },
          ]}
        >
          {match[4]}
        </Text>,
      );
    } else if (match[5] !== undefined && match[6] !== undefined) {
      // Link: [text](url)
      const url = match[6];
      elements.push(
        <Text
          key={`${keyPrefix}-a${idx}`}
          style={[baseStyle, { color: colors.light.primary, textDecorationLine: "underline" }]}
          onPress={() => Linking.openURL(url)}
        >
          {match[5]}
        </Text>,
      );
    }

    lastIndex = match.index + match[0].length;
    idx++;
  }

  // Remaining text after last match
  if (lastIndex < text.length) {
    elements.push(
      <Text key={`${keyPrefix}-t${idx}`} style={baseStyle}>
        {text.slice(lastIndex)}
      </Text>,
    );
  }

  return elements;
}

export function ChatMessage({ message, gatewayUrl }: { message: Message; gatewayUrl?: string }) {
  const isCode = message.content.includes("```");
  const imageMatches = extractImageLinks(message.content);
  const fileMatches = extractFileLinks(message.content);

  const entering = message.role === "user"
    ? FadeInRight.duration(200)
    : FadeInLeft.duration(200);

  return (
    <Animated.View entering={entering}>
      <View style={[styles.bubble, roleContainerStyles[message.role]]}>
        {message.tool && (
          <Text style={styles.toolLabel}>{message.tool}</Text>
        )}
        {imageMatches.length > 0 && gatewayUrl && (
          <ImageAttachments images={imageMatches} gatewayUrl={gatewayUrl} />
        )}
        {isCode ? (
          <CodeContent content={message.content} role={message.role} />
        ) : (
          <Text style={[styles.text, roleTextStyles[message.role]]}>
            {renderMarkdown(message.content, { ...styles.text, ...roleTextStyles[message.role] })}
          </Text>
        )}
        {fileMatches.length > 0 && gatewayUrl && (
          <FileAttachments files={fileMatches} gatewayUrl={gatewayUrl} />
        )}
      </View>
      <Text style={[styles.timestamp, timestampAlignStyles[message.role]]}>
        {new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </Text>
    </Animated.View>
  );
}

function extractImageLinks(content: string): { alt: string; path: string }[] {
  const results: { alt: string; path: string }[] = [];
  const re = /!\[([^\]]*)\]\((\/files\/[^\s)]+)\)/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    results.push({ alt: match[1], path: match[2] });
  }
  return results;
}

function extractFileLinks(content: string): { name: string; path: string }[] {
  const results: { name: string; path: string }[] = [];
  const re = /\[([^\]]+)\]\((\/files\/[^\s)]+)\)/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    if (!IMAGE_EXTENSIONS.test(match[2])) {
      results.push({ name: match[1], path: match[2] });
    }
  }
  return results;
}

function ImageAttachments({ images, gatewayUrl }: { images: { alt: string; path: string }[]; gatewayUrl: string }) {
  return (
    <View style={styles.imageContainer}>
      {images.map((img, i) => (
        <Image
          key={i}
          source={{ uri: `${gatewayUrl}${img.path}` }}
          style={styles.inlineImage}
          resizeMode="contain"
          accessibilityLabel={img.alt || "Image"}
        />
      ))}
    </View>
  );
}

function FileAttachments({ files, gatewayUrl }: { files: { name: string; path: string }[]; gatewayUrl: string }) {
  return (
    <View style={styles.filesContainer}>
      {files.map((file, i) => (
        <Pressable
          key={i}
          onPress={() => Linking.openURL(`${gatewayUrl}${file.path}`)}
          style={({ pressed }) => [styles.fileCard, pressed && styles.fileCardPressed]}
        >
          <Ionicons name="document-outline" size={16} color={colors.light.primary} />
          <Text style={styles.fileName} numberOfLines={1}>
            {file.name}
          </Text>
          <Ionicons name="download-outline" size={14} color={colors.light.mutedForeground} />
        </Pressable>
      ))}
    </View>
  );
}

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const handleCopy = useCallback(async () => {
    await Clipboard.setStringAsync(code);
  }, [code]);

  return (
    <View style={styles.codeBlock}>
      <View style={styles.codeHeader}>
        {lang ? (
          <Text style={styles.codeLang}>{lang}</Text>
        ) : (
          <View />
        )}
        <Pressable
          onPress={handleCopy}
          style={({ pressed }) => [
            styles.copyButton,
            pressed && styles.copyButtonPressed,
          ]}
        >
          <Ionicons name="copy-outline" size={12} color={colors.light.mutedForeground} />
          <Text style={styles.copyText}>Copy</Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator>
        <Text selectable style={styles.codeText}>{code}</Text>
      </ScrollView>
    </View>
  );
}

function CodeContent({ content, role }: { content: string; role: Message["role"] }) {
  const parts = content.split(/(```[\s\S]*?```)/g);

  return (
    <View style={styles.codeContainer}>
      {parts.map((part, i) => {
        if (part.startsWith("```")) {
          const lines = part.slice(3, -3).split("\n");
          const lang = lines[0]?.trim();
          const code = (lang ? lines.slice(1) : lines).join("\n").trim();
          return <CodeBlock key={i} code={code} lang={lang || undefined} />;
        }
        if (part.trim()) {
          return (
            <Text key={i} style={[styles.text, roleTextStyles[role]]}>
              {renderMarkdown(part, { ...styles.text, ...roleTextStyles[role] })}
            </Text>
          );
        }
        return null;
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bubble: {
    maxWidth: "85%",
    borderRadius: 16,
    borderCurve: "continuous" as const,
    paddingHorizontal: spacing.lg,
    paddingVertical: 10,
  },
  toolLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.light.mutedForeground,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 4,
  },
  text: {
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 20,
  },
  timestamp: {
    fontFamily: fonts.sans,
    fontSize: 10,
    color: colors.light.mutedForeground,
    marginTop: 2,
    marginHorizontal: 4,
  },
  codeContainer: {
    gap: 6,
  },
  codeBlock: {
    backgroundColor: "rgba(28, 25, 23, 0.08)",
    borderRadius: radius.sm,
    borderCurve: "continuous" as const,
    padding: spacing.md,
    marginVertical: 4,
  },
  codeHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  codeLang: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.light.mutedForeground,
    textTransform: "uppercase",
  },
  copyButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: "rgba(28, 25, 23, 0.06)",
  },
  copyButtonPressed: {
    opacity: 0.6,
  },
  copyText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.light.mutedForeground,
  },
  codeText: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.light.foreground,
    lineHeight: 18,
  },
  imageContainer: {
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  inlineImage: {
    width: "100%",
    height: 200,
    borderRadius: radius.sm,
  },
  filesContainer: {
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  fileCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    borderRadius: radius.sm,
    borderCurve: "continuous" as const,
    backgroundColor: "rgba(28, 25, 23, 0.04)",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  fileCardPressed: {
    opacity: 0.7,
  },
  fileName: {
    flex: 1,
    fontFamily: fonts.sansMedium,
    fontSize: 13,
    color: colors.light.foreground,
  },
});
