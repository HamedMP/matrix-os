const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/g;

const FILE_EXTENSIONS = /\.(ts|js|tsx|jsx|py|rs|go|md|json|yaml|yml|toml|css|html|sh|sql|rb|java|kt|swift|c|cpp|h)$/;
const FILE_PATH_REGEX = /(?:\.{1,2}\/|\/)[^\s:]+(?::\d+(?::\d+)?)?/g;

interface LinkMatch {
  text: string;
  startIndex: number;
}

export function detectUrls(text: string): LinkMatch[] {
  const matches: LinkMatch[] = [];
  let match: RegExpExecArray | null;
  URL_REGEX.lastIndex = 0;
  while ((match = URL_REGEX.exec(text)) !== null) {
    let url = match[0];
    // Strip trailing punctuation that's unlikely to be part of the URL
    url = url.replace(/[.,;:!?)]+$/, "");
    matches.push({ text: url, startIndex: match.index });
  }
  return matches;
}

export function detectFilePaths(text: string): LinkMatch[] {
  const matches: LinkMatch[] = [];
  let match: RegExpExecArray | null;
  FILE_PATH_REGEX.lastIndex = 0;
  while ((match = FILE_PATH_REGEX.exec(text)) !== null) {
    const raw = match[0];
    // Extract the base path (strip :line:col suffix for extension check)
    const basePath = raw.replace(/:\d+(?::\d+)?$/, "");
    if (FILE_EXTENSIONS.test(basePath)) {
      matches.push({ text: raw, startIndex: match.index });
    }
  }
  return matches;
}

export class WebLinkProvider {
  provideLinks(
    bufferLineNumber: number,
    callback: (links: Array<{
      range: { start: { x: number; y: number }; end: { x: number; y: number } };
      text: string;
      activate: () => void;
    }> | undefined) => void,
    _terminal?: { buffer: { active: { getLine: (n: number) => { translateToString: () => string } | undefined } } },
  ): void {
    if (!_terminal) {
      callback(undefined);
      return;
    }

    const line = _terminal.buffer.active.getLine(bufferLineNumber - 1);
    if (!line) {
      callback(undefined);
      return;
    }

    const text = line.translateToString();
    const links: Array<{
      range: { start: { x: number; y: number }; end: { x: number; y: number } };
      text: string;
      activate: () => void;
    }> = [];

    const urls = detectUrls(text);
    for (const url of urls) {
      links.push({
        range: {
          start: { x: url.startIndex + 1, y: bufferLineNumber },
          end: { x: url.startIndex + url.text.length + 1, y: bufferLineNumber },
        },
        text: url.text,
        activate: () => {
          window.open(url.text, "_blank");
        },
      });
    }

    const filePaths = detectFilePaths(text);
    for (const fp of filePaths) {
      links.push({
        range: {
          start: { x: fp.startIndex + 1, y: bufferLineNumber },
          end: { x: fp.startIndex + fp.text.length + 1, y: bufferLineNumber },
        },
        text: fp.text,
        activate: () => {
          navigator.clipboard.writeText(fp.text).catch(() => {
            // clipboard API not available in this environment
          });
        },
      });
    }

    callback(links.length > 0 ? links : undefined);
  }
}
