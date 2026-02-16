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

export function extractRawText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
