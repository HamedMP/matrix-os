export interface ReadabilityResult {
  title: string;
  content: string;
  textContent: string;
  excerpt: string;
}

export async function extractWithReadability(
  html: string,
  url: string,
): Promise<ReadabilityResult | null> {
  const { parseHTML } = await import("linkedom");
  const { Readability } = await import("@mozilla/readability");

  const { document } = parseHTML(html);

  const reader = new Readability(document as unknown as Document, {
    charThreshold: 0,
  });
  const article = reader.parse();
  if (!article || !article.textContent?.trim()) return null;

  const { default: TurndownService } = await import("turndown");
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });
  const markdown = turndown.turndown(article.content ?? "");

  return {
    title: article.title ?? "",
    content: markdown,
    textContent: article.textContent,
    excerpt: article.excerpt ?? "",
  };
}

function stripRawElements(html: string, tag: "script" | "style"): string {
  const openings = new RegExp(`<${tag}(?=[\\s/>])`, "gi");
  const closings = new RegExp(`</${tag}(?=[\\s/>])`, "gi");
  let copiedUntil = 0;
  let output = "";
  let opening: RegExpExecArray | null;
  while ((opening = openings.exec(html))) {
    closings.lastIndex = openings.lastIndex;
    const closing = closings.exec(html);
    // Preserve unmatched openings for ordinary tag stripping. The suffix is
    // searched only once, rather than again for every remaining opening.
    if (!closing) break;
    const closingEnd = html.indexOf(">", closings.lastIndex);
    if (closingEnd === -1) break;
    output += html.slice(copiedUntil, opening.index);
    copiedUntil = closingEnd + 1;
    openings.lastIndex = copiedUntil;
  }
  return output + html.slice(copiedUntil);
}

export function extractRawText(html: string): string {
  const visible = stripRawElements(stripRawElements(html, "script"), "style");
  let output = "";
  let copiedUntil = 0;
  let opening = visible.indexOf("<");
  while (opening !== -1) {
    const closing = visible.indexOf(">", opening + 1);
    // Unterminated markup remains literal text; never rescan its suffix.
    if (closing === -1) break;
    if (closing > opening + 1) {
      output += visible.slice(copiedUntil, opening) + " ";
      copiedUntil = closing + 1;
    }
    opening = visible.indexOf("<", closing + 1);
  }
  return (output + visible.slice(copiedUntil)).replace(/\s+/g, " ").trim();
}
