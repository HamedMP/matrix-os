// Reads Kotlin and Java sources well enough to say which names a package
// really declares, for expo-native-core-compat.test.ts. It follows braces so a
// nested or function-local declaration is not mistaken for a top-level one, and
// it drops comments and string literals before looking for declarations.

export type SourceLanguage = "kotlin" | "java";

type NameSet = Record<string, true>;

export interface CoreIndex {
  /** Packages that have at least one source file. */
  packages: NameSet;
  /** Top-level functions, properties and type aliases, by qualified name. */
  symbols: NameSet;
  /** Types by qualified name, each with the identifiers written directly in its body. */
  types: Record<string, NameSet>;
}

const TOKEN = /`[^`\n]+`|[A-Za-z_$][\w$]*|::|[{}().,:;=<>?*]/g;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const PACKAGE = /^\s*package\s+([\w.]+)/m;
const CORE_IMPORT = /^\s*import\s+(?:static\s+)?(expo\.modules\.(?:kotlin|core)\.[\w.]+?(?:\.\*)?)\s*(?:;|$|\sas\s)/gm;

export function createCoreIndex(): CoreIndex {
  return { packages: Object.create(null), symbols: Object.create(null), types: Object.create(null) };
}

export function languageOf(file: string): SourceLanguage {
  return file.endsWith(".java") ? "java" : "kotlin";
}

/** Replaces comments and string/char literals with spaces, keeping line breaks. */
function blankNonCode(source: string, language: SourceLanguage): string {
  const out = source.split("");
  let i = 0;

  function blank(from: number, to: number) {
    for (let k = from; k < to && k < out.length; k += 1) {
      if (out[k] !== "\n") out[k] = " ";
    }
  }

  function skipBlockComment() {
    const start = i;
    let depth = 1;
    i += 2;
    while (i < source.length && depth > 0) {
      if (source.startsWith("*/", i)) {
        depth -= 1;
        i += 2;
      } else if (language === "kotlin" && source.startsWith("/*", i)) {
        // Kotlin block comments nest; Java's end at the first terminator.
        depth += 1;
        i += 2;
      } else {
        i += 1;
      }
    }
    blank(start, i);
  }

  function skipChar() {
    const start = i;
    i += source[i + 1] === "\\" ? 3 : 2;
    while (i < source.length && source[i] !== "'" && source[i] !== "\n") i += 1;
    if (source[i] === "'") i += 1;
    blank(start, i);
  }

  function skipString() {
    const start = i;
    const raw = source.startsWith('"""', i);
    i += raw ? 3 : 1;
    while (i < source.length) {
      if (raw && source.startsWith('"""', i)) {
        i += 3;
        while (source[i] === '"') i += 1;
        break;
      }
      if (!raw && source[i] === "\\") {
        i += 2;
        continue;
      }
      if (!raw && (source[i] === '"' || source[i] === "\n")) {
        if (source[i] === '"') i += 1;
        break;
      }
      if (language === "kotlin" && source[i] === "$" && source[i + 1] === "{") {
        // A template holds code, which may hold its own strings and braces.
        i += 2;
        skipCode(true);
        i += 1;
        continue;
      }
      i += 1;
    }
    blank(start, i);
  }

  /** Walks code; inside a string template it stops at the template's closing brace. */
  function skipCode(inTemplate: boolean) {
    let depth = 0;
    while (i < source.length) {
      const char = source[i];
      const next = source[i + 1];
      if (char === "/" && next === "/") {
        const lineEnd = source.indexOf("\n", i);
        const stop = lineEnd < 0 ? source.length : lineEnd;
        blank(i, stop);
        i = stop;
      } else if (char === "/" && next === "*") {
        skipBlockComment();
      } else if (char === '"') {
        skipString();
      } else if (char === "'") {
        skipChar();
      } else {
        if (inTemplate && char === "{") depth += 1;
        if (inTemplate && char === "}") {
          if (depth === 0) return;
          depth -= 1;
        }
        i += 1;
      }
    }
  }

  skipCode(false);
  return out.join("");
}

function isIdentifier(token: string | undefined): token is string {
  return token !== undefined && (IDENTIFIER.test(token) || token.startsWith("`"));
}

function unquote(token: string): string {
  return token.startsWith("`") ? token.slice(1, -1) : token;
}

/** Index after a balanced `<...>` that starts at `at`, or `at` when none starts there. */
function skipTypeArguments(tokens: string[], at: number): number {
  if (tokens[at] !== "<") return at;
  let depth = 0;
  for (let j = at; j < tokens.length; j += 1) {
    if (tokens[j] === "<") depth += 1;
    if (tokens[j] === ">") {
      depth -= 1;
      if (depth === 0) return j + 1;
    }
  }
  return tokens.length;
}

/** Name of the function declared by the `fun` at `at`: the identifier before its parameter list. */
function functionName(tokens: string[], at: number): string | undefined {
  let j = skipTypeArguments(tokens, at + 1);
  let name: string | undefined;
  while (j < tokens.length) {
    const token = tokens[j]!;
    if (token === "(") return name;
    if (token === "<") {
      j = skipTypeArguments(tokens, j);
    } else if (isIdentifier(token)) {
      name = unquote(token);
      j += 1;
    } else if (token === "." || token === "?") {
      j += 1;
    } else {
      return undefined;
    }
  }
  return undefined;
}

/** Name of the property declared by the `val`/`var` at `at`, past any extension receiver. */
function propertyName(tokens: string[], at: number): string | undefined {
  let j = skipTypeArguments(tokens, at + 1);
  let name: string | undefined;
  while (isIdentifier(tokens[j])) {
    name = unquote(tokens[j]!);
    j = skipTypeArguments(tokens, j + 1);
    while (tokens[j] === "?") j += 1;
    if (tokens[j] !== ".") break;
    j += 1;
  }
  return name;
}

/** Adds the declarations of one source file to the index. */
export function indexSource(index: CoreIndex, source: string, language: SourceLanguage): void {
  const code = blankNonCode(source, language);
  const packageName = PACKAGE.exec(code)?.[1];
  if (!packageName) return;
  index.packages[packageName] = true;

  const tokens = code.match(TOKEN) ?? [];
  // One entry per open brace: the type whose body it opens, or null for any
  // other block (function body, lambda, initializer).
  const scopes: (string | null)[] = [];
  const companionOwner: Record<string, string> = Object.create(null);
  let pendingType: string | undefined;
  let parenDepth = 0;

  const typeKeywords = language === "kotlin" ? ["class", "interface", "object"] : ["class", "interface", "enum"];
  const endsPendingType = language === "kotlin" ? ["fun", "val", "var", "typealias", "import"] : ["import"];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token === "(") parenDepth += 1;
    else if (token === ")") parenDepth -= 1;
    else if (token === "{") {
      scopes.push(parenDepth === 0 && pendingType ? pendingType : null);
      if (parenDepth === 0) pendingType = undefined;
    } else if (token === "}") {
      scopes.pop();
      pendingType = undefined;
    } else if (parenDepth === 0 && (token === ";" || token === "=" || token === "init")) {
      // Past the header of a type declared without a body.
      pendingType = undefined;
    }
    if (parenDepth !== 0 || !isIdentifier(token)) continue;

    // The package itself at top level, a type inside its body, null elsewhere.
    const owner: string | null = scopes.length === 0 ? packageName : (scopes[scopes.length - 1] ?? null);
    const ownerIsType = scopes.length > 0 && owner !== null;
    if (owner !== null && ownerIsType) {
      index.types[owner]![unquote(token)] = true;
      // Companion members are also reachable through the enclosing type.
      const enclosing = companionOwner[owner];
      if (enclosing) index.types[enclosing]![unquote(token)] = true;
    }

    const previous = tokens[i - 1];
    const next = tokens[i + 1];
    // `Foo::class` and Java's `Foo.class` are references, not declarations.
    const isClassReference = token === "class" && (previous === "::" || previous === ".");
    if (typeKeywords.includes(token) && !isClassReference) {
      pendingType = undefined;
      let name: string | undefined;
      if (token === "object") {
        // `object : Base { }` is an expression, not a declaration.
        if (isIdentifier(next)) name = unquote(next);
        else if (previous === "companion") name = "Companion";
      } else if (isIdentifier(next)) {
        name = unquote(next);
      }
      if (name && owner !== null) {
        const qualified = `${owner}.${name}`;
        index.types[qualified] ??= Object.create(null) as NameSet;
        if (previous === "companion" && ownerIsType) companionOwner[qualified] = owner;
        pendingType = qualified;
      }
    } else if (endsPendingType.includes(token)) {
      // A type declared without a body does not own the next brace.
      pendingType = undefined;
      if (scopes.length > 0) continue;
      const name =
        token === "fun" ? functionName(tokens, i)
        : token === "typealias" ? (isIdentifier(next) ? unquote(next) : undefined)
        : token === "import" ? undefined
        : propertyName(tokens, i);
      if (name) index.symbols[`${packageName}.${name}`] = true;
    }
  }
}

/** The `expo.modules.kotlin` / `expo.modules.core` names a source file imports. */
export function coreImports(source: string, language: SourceLanguage): string[] {
  return [...blankNonCode(source, language).matchAll(CORE_IMPORT)].map((match) => match[1]!);
}

/**
 * Whether the index declares what an import names: a top-level declaration, a
 * type (nested ones by their full path), or a name written directly in the
 * body of a declared type, such as an enum entry or a member function.
 */
export function resolvesInCore(index: CoreIndex, importPath: string): boolean {
  if (importPath.endsWith(".*")) {
    const target = importPath.slice(0, -2);
    return Object.hasOwn(index.packages, target) || Object.hasOwn(index.types, target);
  }
  if (Object.hasOwn(index.symbols, importPath) || Object.hasOwn(index.types, importPath)) return true;
  const cut = importPath.lastIndexOf(".");
  const members = index.types[importPath.slice(0, cut)];
  return members !== undefined && Object.hasOwn(members, importPath.slice(cut + 1));
}
