import type { UnistylesThemes } from "react-native-unistyles";

import type { ChatMarkdownTheme } from "@/lib/chat-markdown";

/** The colours and type a reply's markdown is drawn with. */
export function chatMarkdownTheme(tokens: UnistylesThemes["light"]["v2"]): ChatMarkdownTheme {
  return {
    textStyle: { ...tokens.text.callout, color: tokens.colors.textDefault },
    mutedColor: tokens.colors.textSubtle,
    linkColor: tokens.colors.info,
    codeBackground: tokens.colors.card,
    codeBorderColor: tokens.colors.borderHairline,
    monoFontFamily: tokens.fonts.mono,
    boldFontFamily: tokens.fonts.semibold,
    headingFontFamily: tokens.fonts.semibold,
  };
}
