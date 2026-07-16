import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { EditorThemeColors } from "../../design/themes";

/** Builds CodeMirror chrome + syntax extensions from a unified theme's editor layer. */
export function buildEditorTheme(colors: EditorThemeColors, dark: boolean): Extension[] {
  const chrome = EditorView.theme(
    {
      "&": { color: colors.foreground, backgroundColor: colors.background },
      ".cm-content": { caretColor: colors.cursor },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: colors.cursor },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
        backgroundColor: colors.selection,
      },
      ".cm-activeLine": { backgroundColor: colors.lineHighlight },
      ".cm-gutters": {
        backgroundColor: colors.gutterBackground,
        color: colors.gutterForeground,
        border: "none",
      },
      ".cm-activeLineGutter": { backgroundColor: colors.lineHighlight },
    },
    { dark },
  );
  const highlight = HighlightStyle.define([
    { tag: [tags.keyword, tags.modifier, tags.operatorKeyword, tags.controlKeyword], color: colors.keyword },
    { tag: [tags.string, tags.special(tags.string)], color: colors.string },
    { tag: [tags.comment, tags.blockComment, tags.lineComment], color: colors.comment, fontStyle: "italic" },
    { tag: [tags.number, tags.bool, tags.null], color: colors.number },
    { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: colors.function },
    { tag: [tags.typeName, tags.className, tags.namespace], color: colors.type },
    { tag: [tags.operator, tags.punctuation], color: colors.operator },
    { tag: [tags.variableName, tags.definition(tags.variableName)], color: colors.variable },
    { tag: [tags.propertyName, tags.attributeName], color: colors.property },
    { tag: [tags.link, tags.url], color: colors.link, textDecoration: "underline" },
    { tag: tags.heading, color: colors.heading, fontWeight: "bold" },
  ]);
  return [chrome, syntaxHighlighting(highlight)];
}
