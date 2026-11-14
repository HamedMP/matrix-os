import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";

import type { ChatMarkdownTheme } from "@/lib/chat-markdown";
import { copyToClipboard } from "@/lib/copy-to-clipboard";

/** How long the copy button says Copied. */
export const CODE_COPIED_MS = 2000;

/** What a person is told when copying code from a reply does not work. */
export const CODE_COPY_FAILED = "Could not copy code. Try again.";

export interface ChatCodeBlockProps {
  /** The code as it is copied: the lines between the fences. */
  code: string;
  /** The fence's language, if it names one. */
  language: string;
  theme: ChatMarkdownTheme;
  /** The code as it is drawn, with any parts still fading in. */
  children: ReactNode;
}

/**
 * A fenced code block in a reply: a header naming its language with a button
 * that copies the code, then the code. Like Desktop, a block without a
 * language is called "text".
 */
export function ChatCodeBlock({ code, language, theme, children }: ChatCodeBlockProps) {
  const [copied, setCopied] = useState(false);
  // Only the latest press decides what the button says, and nothing changes
  // once the block has gone.
  const attempt = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), CODE_COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    const mine = ++attempt.current;
    const current = () => mounted.current && mine === attempt.current;
    setCopied(false);
    const ok = await copyToClipboard(code, { failed: CODE_COPY_FAILED }, current);
    if (ok && current()) setCopied(true);
  };

  const labelStyle = { ...theme.textStyle, fontSize: 12.5, lineHeight: 16, color: theme.mutedColor };
  return (
    <View
      style={{
        backgroundColor: theme.codeBackground,
        borderWidth: 1,
        borderColor: theme.codeBorderColor,
        borderRadius: 8,
        marginVertical: 4,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          paddingLeft: 10,
          borderBottomWidth: 1,
          borderBottomColor: theme.codeBorderColor,
        }}
      >
        <Text numberOfLines={1} style={[labelStyle, { fontFamily: theme.monoFontFamily, flexShrink: 1 }]}>
          {language || "text"}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Copy code"
          accessibilityState={{ selected: copied }}
          hitSlop={8}
          onPress={() => void copy()}
          style={({ pressed }) => ({ paddingHorizontal: 10, paddingVertical: 6, opacity: pressed ? 0.5 : 1 })}
        >
          <Text style={[labelStyle, copied ? { color: theme.textStyle.color } : null]}>{copied ? "Copied" : "Copy"}</Text>
        </Pressable>
      </View>
      <Text style={{ fontFamily: theme.monoFontFamily, fontSize: 12.5, color: theme.textStyle.color, padding: 10 }}>
        {children}
      </Text>
    </View>
  );
}
