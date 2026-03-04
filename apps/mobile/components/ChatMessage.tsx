import { useCallback, useState } from "react";
import { View, Text, ScrollView, Pressable, Image, Linking, StyleSheet } from "react-native";
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

const IMAGE_EXTENSIONS = /\.(png|jpg|jpeg|gif|webp|svg)$/i;

export function ChatMessage({ message, gatewayUrl }: { message: Message; gatewayUrl?: string }) {
  const isCode = message.content.includes("```");
  const imageMatches = extractImageLinks(message.content);
  const fileMatches = extractFileLinks(message.content);

  return (
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
          {message.content}
        </Text>
      )}
      {fileMatches.length > 0 && gatewayUrl && (
        <FileAttachments files={fileMatches} gatewayUrl={gatewayUrl} />
      )}
    </View>
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
        <Text style={styles.codeText}>{code}</Text>
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
              {part}
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
  codeContainer: {
    gap: 6,
  },
  codeBlock: {
    backgroundColor: "rgba(28, 25, 23, 0.08)",
    borderRadius: radius.sm,
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
