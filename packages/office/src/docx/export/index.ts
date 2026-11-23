/**
 * Exports of a `.docx` document: semantic HTML in three modes, Markdown and
 * plain text with numbering labels. All three work on any `DocxDocument`.
 */

export { type HtmlExportMode, type HtmlExportOptions, toHtml } from "./html.js";
export { type MarkdownExportOptions, escapeMarkdownText, toMarkdown } from "./markdown.js";
export { type PlainTextExportOptions, toPlainText } from "./plain-text.js";
export { type FlatBlock, type FlatParagraph, type FlatTable, flattenBlocks, goneInView } from "./flatten.js";
export { escapeHtml, safeExternalHref } from "./escape.js";
