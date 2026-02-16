import { View, Text, StyleSheet } from "react-native";
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

export function ChatMessage({ message }: { message: Message }) {
  const isCode = message.content.includes("```");

  return (
    <View style={[styles.bubble, roleContainerStyles[message.role]]}>
      {message.tool && (
        <Text style={styles.toolLabel}>{message.tool}</Text>
      )}
      {isCode ? (
        <CodeContent content={message.content} role={message.role} />
      ) : (
        <Text style={[styles.text, roleTextStyles[message.role]]}>
          {message.content}
        </Text>
      )}
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
          return (
            <View key={i} style={styles.codeBlock}>
              {lang ? (
                <Text style={styles.codeLang}>{lang}</Text>
              ) : null}
              <Text style={styles.codeText}>{code}</Text>
            </View>
          );
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
  codeLang: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.light.mutedForeground,
    textTransform: "uppercase",
    marginBottom: 6,
  },
  codeText: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.light.foreground,
    lineHeight: 18,
  },
});
