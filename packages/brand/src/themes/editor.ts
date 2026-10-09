import type { UnifiedThemeVariant } from './theme-types.js';
/** Monaco projection: pure data, shared with any renderer using Monaco. */
export function monacoTheme(variant: UnifiedThemeVariant, dark: boolean) {
  const e = variant.editor;
  return {
    base: dark ? 'vs-dark' as const : 'vs' as const,
    inherit: true,
    rules: ['keyword', 'string', 'comment', 'number', 'operator', 'type', 'variable', 'function'].map(token => ({ token, foreground: e[token as keyof typeof e].replace('#', '') })),
    colors: { 'editor.background': e.background, 'editor.foreground': e.foreground, 'editorCursor.foreground': e.cursor, 'editor.selectionBackground': e.selection, 'editor.lineHighlightBackground': e.lineHighlight, 'editorLineNumber.foreground': e.gutterForeground },
  };
}

/** CodeMirror projection includes selections and cursor, matching Monaco. */
export function codeMirrorThemeStyles(e: UnifiedThemeVariant['editor']) {
  return {
    '&': { backgroundColor: e.background, color: e.foreground },
    '.cm-gutters': { backgroundColor: e.gutterBackground, color: e.gutterForeground },
    '.cm-activeLine': { backgroundColor: e.lineHighlight },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: e.cursor },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: e.selection },
  };
}
