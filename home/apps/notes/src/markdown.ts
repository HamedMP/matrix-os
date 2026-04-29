function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function inlineMarkdownToHtml(value: string): string {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

export function markdownToHtml(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const html: string[] = [];
  let listMode: "ul" | "ol" | null = null;
  let codeMode = false;
  const codeLines: string[] = [];

  const closeList = () => {
    if (listMode) {
      html.push(`</${listMode}>`);
      listMode = null;
    }
  };

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      closeList();
      if (codeMode) {
        html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        codeLines.length = 0;
        codeMode = false;
      } else {
        codeMode = true;
      }
      continue;
    }

    if (codeMode) {
      codeLines.push(line);
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      closeList();
      html.push(`<h${heading[1].length}>${inlineMarkdownToHtml(heading[2])}</h${heading[1].length}>`);
      continue;
    }

    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    if (unordered) {
      if (listMode !== "ul") {
        closeList();
        listMode = "ul";
        html.push("<ul>");
      }
      html.push(`<li>${inlineMarkdownToHtml(unordered[1])}</li>`);
      continue;
    }

    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (ordered) {
      if (listMode !== "ol") {
        closeList();
        listMode = "ol";
        html.push("<ol>");
      }
      html.push(`<li>${inlineMarkdownToHtml(ordered[1])}</li>`);
      continue;
    }

    const quote = line.match(/^>\s+(.+)$/);
    if (quote) {
      closeList();
      html.push(`<blockquote><p>${inlineMarkdownToHtml(quote[1])}</p></blockquote>`);
      continue;
    }

    if (line.trim() === "") {
      closeList();
      continue;
    }

    closeList();
    html.push(`<p>${inlineMarkdownToHtml(line)}</p>`);
  }

  closeList();
  if (codeMode) {
    html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
  }
  return html.join("\n") || "<p></p>";
}

export function htmlToMarkdown(html: string): string {
  if (typeof document === "undefined") return html;
  const template = document.createElement("template");
  template.innerHTML = html;

  function renderNode(node: Node, listPrefix = ""): string {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (!(node instanceof HTMLElement)) return "";

    const children = Array.from(node.childNodes).map((child) => renderNode(child, listPrefix)).join("");
    switch (node.tagName.toLowerCase()) {
      case "h1": return `# ${children.trim()}\n\n`;
      case "h2": return `## ${children.trim()}\n\n`;
      case "h3": return `### ${children.trim()}\n\n`;
      case "p": return `${children.trim()}\n\n`;
      case "strong": return `**${children}**`;
      case "em": return `*${children}*`;
      case "code": return node.parentElement?.tagName.toLowerCase() === "pre" ? children : `\`${children}\``;
      case "pre": return `\`\`\`\n${node.textContent ?? ""}\n\`\`\`\n\n`;
      case "blockquote": return children.trim().split("\n").map((line) => `> ${line}`).join("\n") + "\n\n";
      case "ul":
        return Array.from(node.children).map((child) => renderNode(child, "- ")).join("") + "\n";
      case "ol":
        return Array.from(node.children).map((child, index) => renderNode(child, `${index + 1}. `)).join("") + "\n";
      case "li": return `${listPrefix}${children.trim()}\n`;
      case "br": return "\n";
      default: return children;
    }
  }

  return Array.from(template.content.childNodes)
    .map((node) => renderNode(node))
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
