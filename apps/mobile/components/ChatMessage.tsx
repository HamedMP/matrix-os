import { useCallback, useEffect, useState, memo } from "react";
import { View, Text, ScrollView, Pressable, Linking } from "react-native";
import { Image } from "expo-image";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import Animated, { FadeInLeft, FadeInRight } from "react-native-reanimated";
import * as Clipboard from "expo-clipboard";
import { Ionicons } from "@expo/vector-icons";
import { fonts } from "@/lib/theme";
import type { Message } from "@/app/(tabs)/chat";
import type { GatewayClient } from "@/lib/gateway-client";

// Role styling lives in the Unistyles sheet below so bubbles follow the active
// color scheme instead of pinning the light palette.
function roleBubbleStyle(role: Message["role"]) {
  switch (role) {
    case "user":
      return styles.bubbleUser;
    case "assistant":
      return styles.bubbleAssistant;
    case "system":
      return styles.bubbleSystem;
    case "tool":
      return styles.bubbleTool;
  }
}

function roleTextStyle(role: Message["role"]) {
  switch (role) {
    case "user":
      return styles.textUser;
    case "assistant":
      return styles.textAssistant;
    case "system":
      return styles.textSystem;
    case "tool":
      return styles.textTool;
  }
}

const timestampAlignStyles: Record<Message["role"], object> = {
  user: { alignSelf: "flex-end" as const },
  assistant: { alignSelf: "flex-start" as const },
  system: { alignSelf: "center" as const },
  tool: { alignSelf: "flex-start" as const },
};

const ENTERING_USER = FadeInRight.duration(200);
const ENTERING_OTHER = FadeInLeft.duration(200);

const IMAGE_EXTENSIONS = /\.(png|jpg|jpeg|gif|webp|svg)$/i;

function markdownToNodes(text: string, baseStyle: object, linkColor: string): React.ReactNode[] {
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
          {inlineMarkdownToNodes(bulletContent, baseStyle, `b-${li}`, linkColor)}
        </Text>,
      );
      continue;
    }

    elements.push(...inlineMarkdownToNodes(line, baseStyle, `l-${li}`, linkColor));
  }

  return elements;
}

function inlineMarkdownToNodes(
  text: string,
  baseStyle: object,
  keyPrefix: string,
  linkColor: string,
): React.ReactNode[] {
  const elements: React.ReactNode[] = [];
  // Match: **bold**, *italic*, `inline code`, [text](url)
  const inlineRe = /(\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
  let lastIndex = 0;
  let match;

  // Keys use the source character offset (stable across renders for the same
  // immutable text), not a loop counter, so React can reconcile reliably.
  while ((match = inlineRe.exec(text)) !== null) {
    // Text before match
    if (match.index > lastIndex) {
      elements.push(
        <Text key={`${keyPrefix}-pre${lastIndex}`} style={baseStyle}>
          {text.slice(lastIndex, match.index)}
        </Text>,
      );
    }

    if (match[2] !== undefined) {
      // Bold: **text**
      elements.push(
        <Text key={`${keyPrefix}-tok${match.index}`} style={[baseStyle, { fontFamily: fonts.sansBold }]}>
          {match[2]}
        </Text>,
      );
    } else if (match[3] !== undefined) {
      // Italic: *text*
      elements.push(
        <Text key={`${keyPrefix}-tok${match.index}`} style={[baseStyle, { fontStyle: "italic" }]}>
          {match[3]}
        </Text>,
      );
    } else if (match[4] !== undefined) {
      // Inline code: `code`
      elements.push(
        <Text
          key={`${keyPrefix}-tok${match.index}`}
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
          key={`${keyPrefix}-tok${match.index}`}
          style={[baseStyle, { color: linkColor, textDecorationLine: "underline" }]}
          onPress={() => Linking.openURL(url)}
        >
          {match[5]}
        </Text>,
      );
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining text after last match
  if (lastIndex < text.length) {
    elements.push(
      <Text key={`${keyPrefix}-tail${lastIndex}`} style={baseStyle}>
        {text.slice(lastIndex)}
      </Text>,
    );
  }

  return elements;
}

export const ChatMessage = memo(function ChatMessage({ message, gatewayUrl, client }: { message: Message; gatewayUrl?: string; client?: GatewayClient | null }) {
  const { theme } = useUnistyles();
  const isCode = message.content.includes("```");
  const imageMatches = extractImageLinks(message.content);
  const fileMatches = extractFileLinks(message.content);

  const entering = message.role === "user"
    ? ENTERING_USER
    : ENTERING_OTHER;

  return (
    <Animated.View entering={entering}>
      <View style={[styles.bubble, roleBubbleStyle(message.role)]}>
        {message.tool && (
          <Text style={styles.toolLabel}>{message.tool}</Text>
        )}
        {imageMatches.length > 0 && client && (
          <ImageAttachments images={imageMatches} client={client} />
        )}
        {isCode ? (
          <CodeContent content={message.content} role={message.role} />
        ) : (
          <Text style={[styles.text, roleTextStyle(message.role)]}>
            {markdownToNodes(message.content, { ...styles.text, ...roleTextStyle(message.role) }, theme.colors.primary)}
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
}, (prev, next) =>
  prev.message.id === next.message.id &&
  prev.message.content === next.message.content &&
  prev.gatewayUrl === next.gatewayUrl &&
  prev.client === next.client,
);

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

/** Strips the leading `/files/` so the remainder is an owner-home relative path. */
function filesUrlToRelPath(path: string): string {
  return path.replace(/^\/files\//, "");
}

// Owner `/files/*` images require the gateway Authorization header and the
// base routing query (`/vm/<handle>?runtime=`), so build the URL through
// `client.homeFileUrl` and attach the auth header once it resolves. The header
// is tracked as three states: `undefined` while pending, `null` when resolution
// failed or produced an empty credential, and a non-empty string when ready.
// The <Image> mounts only in the ready state, so it never renders without the
// credential and 401s on an authed gateway, mirroring the file preview path.
const IMAGE_AUTH_RETRY_DELAY_MS = 1_500;
const IMAGE_AUTH_MAX_ATTEMPTS = 3;

function ImageAttachments({ images, client }: { images: { alt: string; path: string }[]; client: GatewayClient }) {
  const [header, setHeader] = useState<string | null | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    // A transient token failure must not permanently hide the images for this
    // message: retry a bounded number of times before settling on hidden.
    const scheduleRetry = () => {
      if (cancelled || attempt >= IMAGE_AUTH_MAX_ATTEMPTS - 1) {
        if (!cancelled) setHeader(null);
        return;
      }
      retryTimer = setTimeout(() => {
        if (!cancelled) setAttempt((current) => current + 1);
      }, IMAGE_AUTH_RETRY_DELAY_MS);
    };
    client.getAuthorizationHeader()
      .then((resolved) => {
        if (cancelled) return;
        if (resolved) {
          setHeader(resolved);
          return;
        }
        scheduleRetry();
      })
      .catch((err: unknown) => {
        console.warn("[mobile] chat image auth header unavailable", err instanceof Error ? err.name : "unknown");
        scheduleRetry();
      });
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [client, attempt]);

  // Render nothing until a non-empty Authorization header is available.
  if (!header) return null;

  return (
    <View style={styles.imageContainer}>
      {images.map((img) => (
        <Image
          key={img.path}
          accessibilityLabel={img.alt || "Image"}
          source={{
            uri: client.homeFileUrl(filesUrlToRelPath(img.path)),
            headers: { Authorization: header },
          }}
          style={styles.inlineImage}
          contentFit="contain"
        />
      ))}
    </View>
  );
}

function FileAttachments({ files, gatewayUrl }: { files: { name: string; path: string }[]; gatewayUrl: string }) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.filesContainer}>
      {files.map((file) => (
        <Pressable
          key={file.path}
          onPress={() => Linking.openURL(`${gatewayUrl}${file.path}`)}
          style={({ pressed }) => [styles.fileCard, pressed && styles.fileCardPressed]}
        >
          <Ionicons name="document-outline" size={16} color={theme.colors.primary} />
          <Text style={styles.fileName} numberOfLines={1}>
            {file.name}
          </Text>
          <Ionicons name="download-outline" size={14} color={theme.colors.mutedForeground} />
        </Pressable>
      ))}
    </View>
  );
}

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const { theme } = useUnistyles();
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
          <Ionicons name="copy-outline" size={12} color={theme.colors.mutedForeground} />
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
  const { theme } = useUnistyles();
  // Pair each split segment with its source character offset so keys are stable
  // across renders (the segments concatenate back to the immutable content).
  const parts = content.split(/(```[\s\S]*?```)/g);
  const segments = parts.map((part, index) => {
    const start = parts.slice(0, index).reduce((offset, previous) => offset + previous.length, 0);
    return { part, start };
  });

  return (
    <View style={styles.codeContainer}>
      {segments.map(({ part, start }) => {
        if (part.startsWith("```")) {
          const lines = part.slice(3, -3).split("\n");
          const lang = lines[0]?.trim();
          const code = (lang ? lines.slice(1) : lines).join("\n").trim();
          return <CodeBlock key={`seg-${start}`} code={code} lang={lang || undefined} />;
        }
        if (part.trim()) {
          return (
            <Text key={`seg-${start}`} style={[styles.text, roleTextStyle(role)]}>
              {markdownToNodes(part, { ...styles.text, ...roleTextStyle(role) }, theme.colors.primary)}
            </Text>
          );
        }
        return null;
      })}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  bubble: {
    maxWidth: "85%",
    borderRadius: 16,
    borderCurve: "continuous" as const,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: 10,
  },
  bubbleUser: {
    backgroundColor: theme.colors.primary,
    alignSelf: "flex-end" as const,
  },
  bubbleAssistant: {
    backgroundColor: theme.colors.card,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignSelf: "flex-start" as const,
  },
  bubbleSystem: {
    backgroundColor: "rgba(239, 68, 68, 0.1)",
    alignSelf: "center" as const,
  },
  bubbleTool: {
    backgroundColor: theme.colors.secondary,
    alignSelf: "flex-start" as const,
  },
  textUser: { color: theme.colors.primaryForeground },
  textAssistant: { color: theme.colors.cardForeground },
  textSystem: { color: theme.colors.destructive, fontSize: 12 },
  textTool: { color: theme.colors.mutedForeground, fontSize: 12, fontFamily: theme.fonts.mono },
  toolLabel: {
    fontFamily: theme.fonts.mono,
    fontSize: 10,
    color: theme.colors.mutedForeground,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 4,
  },
  text: {
    fontFamily: theme.fonts.sans,
    fontSize: 14,
    lineHeight: 20,
  },
  timestamp: {
    fontFamily: theme.fonts.sans,
    fontSize: 10,
    color: theme.colors.mutedForeground,
    marginTop: 2,
    marginHorizontal: 4,
  },
  codeContainer: {
    gap: 6,
  },
  codeBlock: {
    backgroundColor: "rgba(28, 25, 23, 0.08)",
    borderRadius: theme.radius.sm,
    borderCurve: "continuous" as const,
    padding: theme.spacing.md,
    marginVertical: 4,
  },
  codeHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  codeLang: {
    fontFamily: theme.fonts.mono,
    fontSize: 10,
    color: theme.colors.mutedForeground,
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
    fontFamily: theme.fonts.mono,
    fontSize: 10,
    color: theme.colors.mutedForeground,
  },
  codeText: {
    fontFamily: theme.fonts.mono,
    fontSize: 12,
    color: theme.colors.foreground,
    lineHeight: 18,
  },
  imageContainer: {
    gap: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
  },
  inlineImage: {
    width: "100%",
    height: 200,
    borderRadius: theme.radius.sm,
  },
  filesContainer: {
    gap: theme.spacing.xs,
    marginTop: theme.spacing.sm,
  },
  fileCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
    borderRadius: theme.radius.sm,
    borderCurve: "continuous" as const,
    backgroundColor: "rgba(28, 25, 23, 0.04)",
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  fileCardPressed: {
    opacity: 0.7,
  },
  fileName: {
    flex: 1,
    fontFamily: theme.fonts.sansMedium,
    fontSize: 13,
    color: theme.colors.foreground,
  },
}));
