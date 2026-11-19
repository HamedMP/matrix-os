// Catch-clause and .catch() handler detection for check-added-patterns.mjs.
// Works on masked source (comments, strings and regex bodies blanked) so
// code-shaped text in prose, prompts or fixtures is ignored.

// Replace comment and string contents with spaces, keeping offsets and
// newlines, so code-shaped text in prose, prompts, or fixtures is ignored.
// Single and double quoted strings end at a newline, which bounds the damage
// from JSX text such as `Don't`.
// Keywords after which `/` starts a regex literal rather than a division.
const REGEX_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await",
]);

function wordBefore(text, index) {
  let end = index;
  while (end > 0 && /\s/.test(text[end - 1])) end -= 1;
  let start = end;
  while (start > 0 && /[\w$]/.test(text[start - 1])) start -= 1;
  if (start > 0 && text[start - 1] === ".") return ""; // a property such as obj.return
  return text.slice(start, end);
}

export function maskSource(text) {
  const out = text.split("");
  const blank = (from, to) => {
    for (let i = from; i < to; i += 1) if (out[i] !== "\n") out[i] = " ";
  };
  // Brace depth of each open `${ ... }` template expression, innermost last.
  const templateDepths = [];
  const scanTemplate = (from) => {
    let j = from;
    while (j < text.length && text[j] !== "`") {
      if (text[j] === "\\") j += 2;
      else if (text[j] === "$" && text[j + 1] === "{") {
        blank(from, j);
        templateDepths.push(0);
        return j + 2;
      } else j += 1;
    }
    blank(from, Math.min(j, text.length));
    return j + 1;
  };
  let i = 0;
  let lastSignificant = "";
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (templateDepths.length > 0 && (ch === "{" || ch === "}")) {
      const top = templateDepths.length - 1;
      if (ch === "{") templateDepths[top] += 1;
      else if (templateDepths[top] > 0) templateDepths[top] -= 1;
      else {
        templateDepths.pop();
        i = scanTemplate(i + 1);
        lastSignificant = "`";
        continue;
      }
    }
    if (ch === "`") {
      i = scanTemplate(i + 1);
      lastSignificant = "`";
      continue;
    }
    if (ch === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) {
        if (text[j] === "\\") j += 1;
        else if (text[j] === "\n") break;
        j += 1;
      }
      blank(i + 1, Math.min(j, text.length));
      i = j + 1;
      lastSignificant = ch;
      continue;
    }
    const regexAllowed =
      lastSignificant === "" ||
      "(,=:[!&|?{};+-*%<>~^".includes(lastSignificant) ||
      (/[\w$]/.test(lastSignificant) && REGEX_KEYWORDS.has(wordBefore(text, i)));
    if (ch === "/" && regexAllowed) {
      let j = i + 1;
      let inClass = false;
      while (j < text.length && text[j] !== "\n" && (inClass || text[j] !== "/")) {
        if (text[j] === "\\") j += 1;
        else if (text[j] === "[") inClass = true;
        else if (text[j] === "]") inClass = false;
        j += 1;
      }
      if (text[j] === "/") {
        blank(i + 1, j);
        i = j + 1;
        lastSignificant = "/";
        continue;
      }
    }
    if (!/\s/.test(ch)) lastSignificant = ch;
    i += 1;
  }
  return out.join("");
}

function matchClose(masked, openIndex, open, close) {
  let depth = 0;
  for (let i = openIndex; i < masked.length; i += 1) {
    if (masked[i] === open) depth += 1;
    else if (masked[i] === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return masked.length;
}

function lineOf(lineStarts, index) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

const uses = (body, name) => new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}(?![\\w$])`).test(body);

// Returns { line, endLine, kind } for each catch that drops its error; line is
// where the catch starts and endLine where its block or handler call closes.
export function findSwallowedErrors(text) {
  const masked = maskSource(text);
  const lineStarts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === "\n") lineStarts.push(i + 1);
  const found = [];

  const clause = /(?<![\w$.]\s*)\bcatch\s*(?:\(([^()]*)\))?\s*\{/g;
  for (let m = clause.exec(masked); m; m = clause.exec(masked)) {
    if (/\.\s*$|\?\.\s*$/.test(masked.slice(Math.max(0, m.index - 3), m.index))) continue;
    const binding = (m[1] ?? "").trim();
    const line = lineOf(lineStarts, m.index);
    const open = m.index + m[0].length - 1;
    const close = matchClose(masked, open, "{", "}");
    const endLine = lineOf(lineStarts, Math.min(close, text.length - 1));
    if (!binding) {
      found.push({ line, endLine, kind: "bare-catch" });
      continue;
    }
    const name = /^([A-Za-z_$][\w$]*)/.exec(binding)?.[1];
    if (!name) continue; // destructuring binds the parts it needs
    if (!uses(masked.slice(open + 1, close), name)) found.push({ line, endLine, kind: "unused-catch-binding", name });
  }

  const method = /\.\s*catch\s*\(/g;
  for (let m = method.exec(masked); m; m = method.exec(masked)) {
    const callOpen = m.index + m[0].length - 1;
    const callClose = matchClose(masked, callOpen, "(", ")");
    const args = masked.slice(callOpen + 1, callClose);
    const line = lineOf(lineStarts, m.index);
    const endLine = lineOf(lineStarts, Math.min(callClose, text.length - 1));
    const handler =
      /^\s*(?:async\s*)?\(\s*([A-Za-z_$][\w$]*)?\s*(?::[^)]*)?\)\s*=>\s*/.exec(args) ??
      /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>\s*/.exec(args) ??
      /^\s*(?:async\s+)?function\s*[\w$]*\s*\(\s*([A-Za-z_$][\w$]*)?\s*(?::[^)]*)?\)\s*/.exec(args);
    if (!handler) continue; // a named handler such as .catch(logFailure)
    const name = handler[1];
    if (!name) {
      found.push({ line, endLine, kind: "empty-catch-handler" });
      continue;
    }
    if (!uses(args.slice(handler[0].length), name)) found.push({ line, endLine, kind: "unused-catch-binding", name });
  }
  return found;
}
