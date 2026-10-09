import { decodeEntities, escapeHtml, validUrl } from "./shared.mjs";
import { replaceText } from "./workspace-tools.mjs";

const words = (input) => input.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? [];
const sentences = (input) => input.split(/[.!?]+/).map((part) => part.trim()).filter(Boolean);

function markdown(input) {
  const emphasis = (value) => value
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>");
  // Protected spans become inert tokens while emphasis sees the entire surrounding text.
  // Escaping user-supplied token delimiters preserves their characters without allowing spoofing.
  const literal = (value) => escapeHtml(value).replaceAll("\uE000", "&#57344;").replaceAll("\uE001", "&#57345;");
  const inline = (value, links = true) => {
    let output = "", offset = 0;
    const protectedSpans = [];
    const spans = links ? /`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g : /`([^`]+)`/g;
    for (const match of value.matchAll(spans)) {
      output += literal(value.slice(offset, match.index));
      let rendered;
      if (match[1] !== undefined) rendered = `<code>${escapeHtml(match[1])}</code>`;
      else {
        const label = inline(match[2], false);
        try { rendered = `<a href="${escapeHtml(validUrl(decodeEntities(match[3])).href)}" rel="noopener noreferrer">${label}</a>`; }
        catch { rendered = label; }
      }
      output += `\uE000${protectedSpans.length}\uE001`;
      protectedSpans.push(rendered);
      offset = match.index + match[0].length;
    }
    output += literal(value.slice(offset));
    return emphasis(output).replace(/\uE000(\d+)\uE001/g, (_token, index) => protectedSpans[Number(index)]);
  };
  return input.split(/\n\s*\n/).map((paragraph) => {
    const lines = paragraph.split("\n");
    if (lines.every((line) => /^#{1,6} /.test(line))) return lines.map((line) => { const depth = line.match(/^#+/)[0].length; return `<h${depth}>${inline(line.slice(depth + 1))}</h${depth}>`; }).join("\n");
    if (lines.every((line) => /^[-*] /.test(line))) return `<ul>\n${lines.map((line) => `<li>${inline(line.slice(2))}</li>`).join("\n")}\n</ul>`;
    return `<p>${lines.map((line) => inline(line)).join("<br>\n")}</p>`;
  }).join("\n\n");
}

export function writingTool(slug, input) {
  switch (slug) {
    case "word-counter": { const count = words(input).length; return `Words: ${count}\nCharacters: ${[...input].length}\nSentences: ${sentences(input).length}\nEstimated reading time: ${Math.max(1, Math.ceil(count / 220))} min`; }
    case "character-counter": return `Characters: ${[...input].length}\nWithout whitespace: ${[...input.replace(/\s/g, "")].length}\nLines: ${input.split("\n").length}\nUTF-8 bytes: ${new TextEncoder().encode(input).length}`;
    case "readability-checker": {
      const all = words(input), count = all.length, sentenceCount = Math.max(1, sentences(input).length);
      const syllables = all.reduce((sum, word) => sum + Math.max(1, (word.toLowerCase().replace(/e$/, "").match(/[aeiouy]+/g) ?? []).length), 0);
      const score = Math.round(206.835 - 1.015 * count / sentenceCount - 84.6 * syllables / Math.max(1, count));
      return `Estimated Flesch reading ease: ${score}\nWords per sentence: ${(count / sentenceCount).toFixed(1)}\nWords with 7+ letters: ${all.filter((word) => word.length >= 7).length}\nEnglish-language heuristic only.`;
    }
    case "case-converter": {
      const match = input.match(/^(upper|lower|title|sentence)\|([\s\S]+)$/);
      if (!match) throw new Error("Start with upper|, lower|, title|, or sentence|.");
      const [, mode, body] = match;
      if (mode === "upper") return body.toUpperCase();
      if (mode === "lower") return body.toLowerCase();
      if (mode === "title") return body.toLowerCase().replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
      return body.toLowerCase().replace(/(^|[.!?]\s+)\p{L}/gu, (value) => value.toUpperCase());
    }
    case "slug-generator": return input.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    case "text-cleaner": return input.replace(/\r\n/g, "\n").split("\n").map((line) => line.trim().replace(/ {2,}/g, " ")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
    case "line-sorter": return input.split("\n").sort((a, b) => a.localeCompare(b)).join("\n");
    case "duplicate-line-remover": return [...new Set(input.split("\n"))].join("\n");
    case "find-replace": {
      const lines = input.split("\n"); if (lines.length < 3 || !lines[0]) throw new Error("Enter search, replacement, and text on consecutive lines.");
      return replaceText(lines.slice(2).join("\n"), lines[0], lines[1]);
    }
    case "markdown-preview": return markdown(input);
    case "html-to-text": return decodeEntities(input.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "").replace(/<\/?(?:p|div|h[1-6]|li|br|section|article)\b[^>]*>/gi, "\n").replace(/<[^>]*>/g, " ").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim());
    case "lorem-ipsum-generator": {
      const count = Number(input.trim()); if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error("Enter 1 to 10 paragraphs.");
      const paragraph = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Integer vitae mauris sed risus fermentum tincidunt. Praesent at sem nec sapien interdum interdum. Donec mattis, enim vitae pretium facilisis, justo velit volutpat nisl, sit amet aliquet mi nibh id arcu.";
      return Array.from({ length: count }, () => paragraph).join("\n\n");
    }
    case "keyword-density-checker": {
      const all = words(input).map((word) => word.toLocaleLowerCase("en"));
      const counts = new Map(); for (const word of all) if (word.length > 2) counts.set(word, (counts.get(word) ?? 0) + 1);
      return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 20).map(([word, count]) => `${word}: ${count} (${(count / all.length * 100).toFixed(1)}%)`).join("\n") || "No repeated terms to report.";
    }
    default: throw new Error("Unknown writing tool.");
  }
}
