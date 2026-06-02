// calc-engine.ts — UI-free, pure expression evaluator for the Matrix OS calculator.
// Tokenizer + recursive-descent parser/evaluator. No eval(), never throws to the UI.

export type TokenType =
  | "number"
  | "op" // + - * / ^
  | "lparen"
  | "rparen"
  | "comma"
  | "percent"
  | "bang" // factorial
  | "ident"; // function name or constant

export interface Token {
  type: TokenType;
  value: string;
}

export interface EvalOptions {
  /** When true, trig functions take/return degrees. Default false (radians). */
  degrees?: boolean;
}

export type EvalResult =
  | { ok: true; value: number }
  | { ok: false; error: string };

class CalcError extends Error {}

const OPERATOR_CHARS = new Set(["+", "-", "*", "/", "^"]);

/**
 * Convert an input string into a flat token stream. Whitespace is ignored.
 * Throws CalcError on an unrecognized character; callers catch it.
 */
export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const src = input;

  while (i < src.length) {
    const ch = src[i];

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }

    // Numbers: digits with optional decimal point. Also leading-dot like ".5".
    if ((ch >= "0" && ch <= "9") || (ch === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i;
      let seenDot = false;
      while (j < src.length) {
        const c = src[j];
        if (c >= "0" && c <= "9") {
          j += 1;
        } else if (c === "." && !seenDot) {
          seenDot = true;
          j += 1;
        } else {
          break;
        }
      }
      if (src[j] === "e" || src[j] === "E") {
        let k = j + 1;
        if (src[k] === "+" || src[k] === "-") k += 1;
        if (src[k] >= "0" && src[k] <= "9") {
          k += 1;
          while (src[k] >= "0" && src[k] <= "9") k += 1;
          j = k;
        }
      }
      tokens.push({ type: "number", value: src.slice(i, j) });
      i = j;
      continue;
    }

    if (OPERATOR_CHARS.has(ch)) {
      tokens.push({ type: "op", value: ch });
      i += 1;
      continue;
    }

    if (ch === "(") {
      tokens.push({ type: "lparen", value: ch });
      i += 1;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "rparen", value: ch });
      i += 1;
      continue;
    }
    if (ch === ",") {
      tokens.push({ type: "comma", value: ch });
      i += 1;
      continue;
    }
    if (ch === "%") {
      tokens.push({ type: "percent", value: ch });
      i += 1;
      continue;
    }
    if (ch === "!") {
      tokens.push({ type: "bang", value: ch });
      i += 1;
      continue;
    }

    // Identifiers: function names and constants (letters + digits, must start with a letter).
    if (/[a-zA-Z]/.test(ch)) {
      let j = i;
      while (j < src.length && /[a-zA-Z0-9_]/.test(src[j])) {
        j += 1;
      }
      tokens.push({ type: "ident", value: src.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }

    throw new CalcError(`Unexpected character "${ch}"`);
  }

  return tokens;
}

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
  tau: Math.PI * 2,
  phi: (1 + Math.sqrt(5)) / 2,
};

function hasOwn<T extends object>(record: T, key: string): key is keyof T & string {
  return Object.prototype.hasOwnProperty.call(record, key);
}

interface FnDef {
  arity: number | "variadic";
  fn: (args: number[], opts: Required<EvalOptions>) => number;
}

function toRad(x: number, opts: Required<EvalOptions>): number {
  return opts.degrees ? (x * Math.PI) / 180 : x;
}
function fromRad(x: number, opts: Required<EvalOptions>): number {
  return opts.degrees ? (x * 180) / Math.PI : x;
}

function factorial(n: number): number {
  if (!Number.isFinite(n)) throw new CalcError("Invalid factorial");
  if (n < 0 || !Number.isInteger(n)) {
    throw new CalcError("Factorial requires a non-negative integer");
  }
  if (n > 170) return Infinity; // overflow guard; > 170! is Infinity in doubles anyway
  let acc = 1;
  for (let k = 2; k <= n; k += 1) acc *= k;
  return acc;
}

const FUNCTIONS: Record<string, FnDef> = {
  sin: { arity: 1, fn: (a, o) => Math.sin(toRad(a[0], o)) },
  cos: { arity: 1, fn: (a, o) => Math.cos(toRad(a[0], o)) },
  tan: { arity: 1, fn: (a, o) => Math.tan(toRad(a[0], o)) },
  asin: { arity: 1, fn: (a, o) => fromRad(Math.asin(a[0]), o) },
  acos: { arity: 1, fn: (a, o) => fromRad(Math.acos(a[0]), o) },
  atan: { arity: 1, fn: (a, o) => fromRad(Math.atan(a[0]), o) },
  sinh: { arity: 1, fn: (a) => Math.sinh(a[0]) },
  cosh: { arity: 1, fn: (a) => Math.cosh(a[0]) },
  tanh: { arity: 1, fn: (a) => Math.tanh(a[0]) },
  ln: { arity: 1, fn: (a) => Math.log(a[0]) },
  log: { arity: 1, fn: (a) => Math.log10(a[0]) },
  log2: { arity: 1, fn: (a) => Math.log2(a[0]) },
  sqrt: { arity: 1, fn: (a) => Math.sqrt(a[0]) },
  cbrt: { arity: 1, fn: (a) => Math.cbrt(a[0]) },
  abs: { arity: 1, fn: (a) => Math.abs(a[0]) },
  exp: { arity: 1, fn: (a) => Math.exp(a[0]) },
  round: { arity: 1, fn: (a) => Math.round(a[0]) },
  floor: { arity: 1, fn: (a) => Math.floor(a[0]) },
  ceil: { arity: 1, fn: (a) => Math.ceil(a[0]) },
  sign: { arity: 1, fn: (a) => Math.sign(a[0]) },
  fact: { arity: 1, fn: (a) => factorial(a[0]) },
  max: { arity: "variadic", fn: (a) => Math.max(...a) },
  min: { arity: "variadic", fn: (a) => Math.min(...a) },
  pow: { arity: 2, fn: (a) => a[0] ** a[1] },
  root: { arity: 2, fn: (a) => a[0] ** (1 / a[1]) },
};

/**
 * Recursive-descent parser that evaluates as it parses.
 *
 * Grammar (highest precedence last):
 *   expr    := term (("+" | "-") term)*
 *   term    := unary (("*" | "/" | "mod") unary)*     (implicit mul handled here)
 *   unary   := ("+" | "-") unary | power
 *   power   := postfix ("^" unary)?                   (right-assoc; "-2^2" = -4)
 *   postfix := primary ("!" | "%")*
 *   primary := number | constant | "(" expr ")" | func "(" args ")"
 */
class Parser {
  private pos = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly opts: Required<EvalOptions>,
  ) {}

  parse(): number {
    if (this.tokens.length === 0) throw new CalcError("Empty expression");
    const value = this.parseExpr();
    if (this.pos < this.tokens.length) {
      throw new CalcError("Unexpected trailing input");
    }
    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new CalcError("Unexpected end of expression");
    this.pos += 1;
    return t;
  }

  private parseExpr(): number {
    let left = this.parseTerm();
    while (true) {
      const t = this.peek();
      if (t && t.type === "op" && (t.value === "+" || t.value === "-")) {
        this.next();
        const right = this.parseTerm();
        left = t.value === "+" ? left + right : left - right;
      } else {
        break;
      }
    }
    return left;
  }

  private parseTerm(): number {
    let left = this.parseUnary();
    while (true) {
      const t = this.peek();
      if (t && t.type === "op" && (t.value === "*" || t.value === "/")) {
        this.next();
        const right = this.parseUnary();
        if (t.value === "/") {
          if (right === 0) throw new CalcError("Cannot divide by zero");
          left = left / right;
        } else {
          left = left * right;
        }
      } else if (t && t.type === "ident" && t.value === "mod") {
        this.next();
        const right = this.parseUnary();
        if (right === 0) throw new CalcError("Cannot divide by zero");
        left = left % right;
      } else if (
        // Implicit multiplication: a value directly followed by a "(" or a
        // constant/function name (e.g. "2pi", "2(3)", "(1+1)(2+2)").
        // Two bare numbers ("3 4") are intentionally NOT implicit-mul — that is
        // a malformed expression.
        t &&
        (t.type === "lparen" || this.isConstantOrFunc(t))
      ) {
        const right = this.parseUnary();
        left = left * right;
      } else {
        break;
      }
    }
    return left;
  }

  private isConstantOrFunc(t: Token): boolean {
    if (t.type !== "ident") return false;
    if (t.value === "mod") return false;
    return hasOwn(CONSTANTS, t.value) || hasOwn(FUNCTIONS, t.value);
  }

  private parseUnary(): number {
    const t = this.peek();
    if (t && t.type === "op" && (t.value === "+" || t.value === "-")) {
      this.next();
      const operand = this.parseUnary();
      return t.value === "-" ? -operand : operand;
    }
    return this.parsePower();
  }

  private parsePower(): number {
    const base = this.parsePostfix();
    const t = this.peek();
    if (t && t.type === "op" && t.value === "^") {
      this.next();
      // Right-associative; RHS allows unary so "2^-3" parses.
      const exponent = this.parseUnary();
      return base ** exponent;
    }
    return base;
  }

  private parsePostfix(): number {
    let value = this.parsePrimary();
    while (true) {
      const t = this.peek();
      if (t && t.type === "bang") {
        this.next();
        value = factorial(value);
      } else if (t && t.type === "percent") {
        this.next();
        value = value / 100;
      } else {
        break;
      }
    }
    return value;
  }

  private parsePrimary(): number {
    const t = this.peek();
    if (!t) throw new CalcError("Unexpected end of expression");

    if (t.type === "number") {
      this.next();
      const n = Number(t.value);
      if (!Number.isFinite(n)) throw new CalcError(`Invalid number "${t.value}"`);
      return n;
    }

    if (t.type === "lparen") {
      this.next();
      const inner = this.parseExpr();
      const closing = this.peek();
      if (!closing || closing.type !== "rparen") {
        throw new CalcError("Mismatched parentheses");
      }
      this.next();
      return inner;
    }

    if (t.type === "ident") {
      this.next();
      // Constant?
      if (hasOwn(CONSTANTS, t.value)) {
        return CONSTANTS[t.value];
      }
      // Function call?
      const fn = hasOwn(FUNCTIONS, t.value) ? FUNCTIONS[t.value] : undefined;
      if (!fn) throw new CalcError(`Unknown function or constant "${t.value}"`);
      const open = this.peek();
      if (!open || open.type !== "lparen") {
        throw new CalcError(`Function "${t.value}" requires parentheses`);
      }
      this.next();
      const args: number[] = [];
      if (this.peek()?.type !== "rparen") {
        args.push(this.parseExpr());
        while (this.peek()?.type === "comma") {
          this.next();
          args.push(this.parseExpr());
        }
      }
      const close = this.peek();
      if (!close || close.type !== "rparen") {
        throw new CalcError("Mismatched parentheses");
      }
      this.next();
      if (fn.arity !== "variadic" && args.length !== fn.arity) {
        throw new CalcError(`"${t.value}" expects ${fn.arity} argument(s)`);
      }
      if (fn.arity === "variadic" && args.length === 0) {
        throw new CalcError(`"${t.value}" expects at least one argument`);
      }
      return fn.fn(args, this.opts);
    }

    throw new CalcError(`Unexpected token "${t.value}"`);
  }
}

/**
 * Safely evaluate an expression string. Never throws — returns a tagged result.
 */
export function evaluate(input: string, options: EvalOptions = {}): EvalResult {
  const opts: Required<EvalOptions> = { degrees: options.degrees ?? false };
  try {
    if (input.trim() === "") {
      return { ok: false, error: "Empty expression" };
    }
    const tokens = tokenize(input);
    const value = new Parser(tokens, opts).parse();
    if (!Number.isFinite(value)) {
      // covers 1/0 -> Infinity escapes, log(0), etc.
      if (Number.isNaN(value)) return { ok: false, error: "Not a number" };
      return { ok: false, error: "Result is infinite" };
    }
    return { ok: true, value };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Invalid expression";
    return { ok: false, error: message };
  }
}

/**
 * Format a numeric result for display: trims float noise, groups thousands,
 * falls back to exponential for very large/small magnitudes.
 */
export function formatResult(value: number): string {
  if (!Number.isFinite(value)) return "Error";
  if (value === 0) return "0";
  const abs = Math.abs(value);
  if (Number.isSafeInteger(value) && abs < 1e15) {
    return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
  }
  if (abs >= 1e15 || (abs < 1e-9 && abs > 0)) {
    return value.toExponential(6).replace(/\.?0+e/, "e");
  }
  // Round to 10 significant decimals to kill binary float noise, then trim.
  const rounded = Number(value.toPrecision(12));
  if (Number.isInteger(rounded)) {
    return rounded.toLocaleString("en-US", { maximumFractionDigits: 0 });
  }
  const str = rounded.toLocaleString("en-US", { maximumFractionDigits: 10 });
  return str;
}
