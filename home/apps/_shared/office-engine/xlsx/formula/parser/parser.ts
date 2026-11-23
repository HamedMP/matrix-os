/**
 * The formula parser: a precedence-climbing parser over the tokens.
 *
 * Binding, tightest first:
 *
 * | Operators                 | Meaning                          | Groups        |
 * | ------------------------- | -------------------------------- | ------------- |
 * | `:`                       | range                            | left to right |
 * | (space)                   | intersection                     | left to right |
 * | `,` inside parentheses    | union                            | left to right |
 * | `-` `+` in front          | negation                         |               |
 * | `%` behind                | percent                          |               |
 * | `^`                       | power                            | left to right |
 * | `*` `/`                   | multiply, divide                 | left to right |
 * | `+` `-`                   | add, subtract                    | left to right |
 * | `&`                       | join text                        | left to right |
 * | `=` `<>` `<` `>` `<=` `>=`| compare                          | left to right |
 *
 * So `-2^2` is 4, `2^3^2` is 64 and `2^-1` is 0.5, as in a spreadsheet.
 * A `,` is the union operator only directly inside parentheses or at the
 * top of a formula; inside a function call it separates arguments.
 */

import type { BinaryOperator, CellNode, FormulaAst, RangeNode } from "../../../api/formula.js";
import { OfficeError } from "../../../errors.js";
import { normalizeCorners, sameSheet } from "./a1.js";
import {
  MAX_AST_DEPTH,
  MAX_CALL_ARGS,
  MAX_FORMULA_LENGTH,
  isReferenceLike,
  type ExtendedAst,
  type ReferenceOperator,
} from "./ast.js";
import { syntaxError, tokenize, type OperatorText, type Token } from "./tokenizer.js";

const BINARY_POWER: Readonly<Partial<Record<OperatorText, number>>> = {
  "^": 50,
  "*": 40,
  "/": 40,
  "+": 30,
  "-": 30,
  "&": 20,
  "=": 10,
  "<>": 10,
  "<": 10,
  ">": 10,
  "<=": 10,
  ">=": 10,
};
const RANGE_POWER = 90;
const INTERSECTION_POWER = 85;
const UNION_POWER = 80;
const PREFIX_POWER = 70;
const PERCENT_POWER = 60;

function startsOperand(token: Token): boolean {
  if (token.kind === "op") return token.op === "(";
  return token.kind === "ref" || token.kind === "name" || token.kind === "func";
}

function describe(token: Token): string {
  switch (token.kind) {
    case "eof":
      return "end of formula";
    case "op":
      return JSON.stringify(token.op);
    case "func":
      return `function ${token.name}`;
    default:
      return `a ${token.kind}`;
  }
}

class Parser {
  private index = 0;
  private depth = 0;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly extended: boolean,
  ) {}

  parse(): ExtendedAst {
    const ast = this.expression(0, true);
    const rest = this.peek();
    if (rest.kind !== "eof") syntaxError(`unexpected ${describe(rest)}`, rest.offset);
    return ast;
  }

  private peek(): Token {
    return this.tokens[this.index] as Token;
  }

  private take(): Token {
    const token = this.tokens[this.index] as Token;
    if (token.kind !== "eof") this.index += 1;
    return token;
  }

  private isOp(token: Token, op: OperatorText): boolean {
    return token.kind === "op" && token.op === op;
  }

  private expect(op: OperatorText): void {
    const token = this.peek();
    if (!this.isOp(token, op)) syntaxError(`expected ${JSON.stringify(op)} but found ${describe(token)}`, token.offset);
    this.index += 1;
  }

  private deeper(offset: number): void {
    this.depth += 1;
    if (this.depth > MAX_AST_DEPTH) {
      throw new OfficeError("limit_exceeded", "formula is nested too deeply", {
        details: { offset, maxDepth: MAX_AST_DEPTH },
      });
    }
  }

  /** Parses operators that bind tighter than `minPower`. */
  private expression(minPower: number, allowUnion: boolean): ExtendedAst {
    const entryDepth = this.depth;
    this.deeper(this.peek().offset);
    let left = this.prefix(allowUnion);
    for (;;) {
      const token = this.peek();
      if (token.kind === "op") {
        const binaryPower = BINARY_POWER[token.op];
        if (binaryPower !== undefined) {
          if (binaryPower <= minPower) break;
          this.index += 1;
          this.deeper(token.offset);
          const right = this.expression(binaryPower, allowUnion);
          left = { type: "binary", op: token.op as BinaryOperator, left, right };
          continue;
        }
        if (token.op === "%") {
          if (PERCENT_POWER <= minPower) break;
          this.index += 1;
          this.deeper(token.offset);
          left = { type: "unary", op: "%", operand: left };
          continue;
        }
        if (token.op === ":") {
          if (RANGE_POWER <= minPower) break;
          this.index += 1;
          this.deeper(token.offset);
          left = this.range(left, this.expression(RANGE_POWER, allowUnion), token.offset);
          continue;
        }
        if (token.op === "," && allowUnion) {
          if (UNION_POWER <= minPower) break;
          this.index += 1;
          this.deeper(token.offset);
          left = this.referenceOperator(",", left, this.expression(UNION_POWER, allowUnion), token.offset);
          continue;
        }
      }
      if (token.space && startsOperand(token) && isReferenceLike(left)) {
        if (INTERSECTION_POWER <= minPower) break;
        this.deeper(token.offset);
        left = this.referenceOperator(" ", left, this.expression(INTERSECTION_POWER, allowUnion), token.offset);
        continue;
      }
      break;
    }
    this.depth = entryDepth;
    return left;
  }

  private prefix(allowUnion: boolean): ExtendedAst {
    const token = this.take();
    switch (token.kind) {
      case "number":
        return { type: "number", value: token.value };
      case "string":
        return { type: "string", value: token.value };
      case "boolean":
        return { type: "boolean", value: token.value };
      case "error":
        return { type: "error", code: token.code };
      case "name":
        return { type: "name", name: token.name, sheet: token.sheet };
      case "ref":
        if (token.node.type === "ref3d" && !this.extended) {
          syntaxError("references across several sheets are not supported", token.offset);
        }
        return token.node;
      case "func":
        return { type: "call", name: token.name, args: this.callArguments(token.offset) };
      case "op":
        if (token.op === "-" || token.op === "+") {
          return { type: "unary", op: token.op, operand: this.expression(PREFIX_POWER, allowUnion) };
        }
        if (token.op === "(") {
          const inner = this.expression(0, true);
          this.expect(")");
          return { type: "paren", inner };
        }
        if (token.op === "{") return this.arrayConstant(token.offset);
        return syntaxError(`unexpected ${describe(token)}`, token.offset);
      default:
        return syntaxError(`unexpected ${describe(token)}`, token.offset);
    }
  }

  private callArguments(offset: number): ExtendedAst[] {
    const args: ExtendedAst[] = [];
    if (this.isOp(this.peek(), ")")) {
      this.index += 1;
      return args;
    }
    for (;;) {
      const token = this.peek();
      if (this.isOp(token, ",") || this.isOp(token, ")")) args.push({ type: "missing" });
      else args.push(this.expression(0, false));
      if (args.length > MAX_CALL_ARGS) syntaxError("too many arguments", offset);
      const after = this.peek();
      if (this.isOp(after, ",")) {
        this.index += 1;
        continue;
      }
      if (this.isOp(after, ")")) {
        this.index += 1;
        return args;
      }
      return syntaxError(`expected "," or ")" but found ${describe(after)}`, after.offset);
    }
  }

  private arrayConstant(offset: number): ExtendedAst {
    const rows: ExtendedAst[][] = [];
    let row: ExtendedAst[] = [];
    for (;;) {
      row.push(this.arrayElement());
      const token = this.take();
      if (this.isOp(token, ",")) continue;
      if (this.isOp(token, ";") || this.isOp(token, "}")) {
        const first = rows[0];
        if (first !== undefined && first.length !== row.length) {
          syntaxError("every row of an array constant needs the same number of values", token.offset);
        }
        rows.push(row);
        row = [];
        if (this.isOp(token, "}")) break;
        continue;
      }
      if (token.kind === "eof") syntaxError("unterminated array constant", offset);
      syntaxError(`expected "," ";" or "}" but found ${describe(token)}`, token.offset);
    }
    return { type: "array", rows };
  }

  private arrayElement(): ExtendedAst {
    const token = this.take();
    switch (token.kind) {
      case "number":
        return { type: "number", value: token.value };
      case "string":
        return { type: "string", value: token.value };
      case "boolean":
        return { type: "boolean", value: token.value };
      case "error":
        return { type: "error", code: token.code };
      case "op": {
        const next = this.peek();
        if ((token.op === "-" || token.op === "+") && next.kind === "number") {
          this.index += 1;
          return { type: "number", value: token.op === "-" ? -next.value : next.value };
        }
        return syntaxError("an array constant holds only numbers, text, booleans and errors", token.offset);
      }
      default:
        return syntaxError("an array constant holds only numbers, text, booleans and errors", token.offset);
    }
  }

  /** `left:right`. Two cells fold into one range node; anything else stays an operator. */
  private range(left: ExtendedAst, right: ExtendedAst, offset: number): ExtendedAst {
    if (right.type === "cell" && (left.type === "cell" || (left.type === "ref3d" && left.ref.type === "cell"))) {
      const first = left.type === "cell" ? left : (left.ref as CellNode);
      const sheet = left.type === "cell" ? left.sheet : null;
      if (right.sheet !== null && (sheet === null || !sameSheet(sheet, right.sheet))) {
        syntaxError("both ends of a range must be on the same sheet", offset);
      }
      const corners = normalizeCorners(
        { row: first.row, col: first.col, rowAbsolute: first.rowAbsolute, colAbsolute: first.colAbsolute },
        { row: right.row, col: right.col, rowAbsolute: right.rowAbsolute, colAbsolute: right.colAbsolute },
      );
      const folded: RangeNode = { type: "range", sheet, shape: "cells", ...corners };
      return left.type === "ref3d" ? { ...left, ref: folded } : folded;
    }
    return this.referenceOperator(":", left, right, offset);
  }

  private referenceOperator(op: ReferenceOperator, left: ExtendedAst, right: ExtendedAst, offset: number): ExtendedAst {
    const label = op === ":" ? "range" : op === "," ? "union" : "intersection";
    if (!isReferenceLike(left) || !isReferenceLike(right)) {
      syntaxError(`the ${label} operator needs a reference on both sides`, offset);
    }
    if (!this.extended) syntaxError(`the ${label} operator is not supported here`, offset);
    return { type: "refop", op, left, right };
  }
}

function parse(text: string, extended: boolean): ExtendedAst {
  if (typeof text !== "string") throw new OfficeError("invalid_argument", "a formula must be text");
  if (text.length > MAX_FORMULA_LENGTH) {
    throw new OfficeError("limit_exceeded", "formula is too long", {
      details: { length: text.length, maxLength: MAX_FORMULA_LENGTH },
    });
  }
  let start = 0;
  while (start < text.length && text.charCodeAt(start) <= 32) start += 1;
  if (text.charAt(start) === "=") start += 1;
  const tokens = tokenize(text, start);
  if ((tokens[0] as Token).kind === "eof") syntaxError("empty formula", (tokens[0] as Token).offset);
  return new Parser(tokens, extended).parse();
}

/**
 * Parses a formula of the contract grammar, with or without the leading `=`.
 * Throws `formula_error` (with `details.offset`) for a syntax error and for
 * the union and intersection operators, a range between anything but two
 * cells, and a reference across several sheets. Throws `limit_exceeded` for
 * a formula longer than {@link MAX_FORMULA_LENGTH} or nested deeper than
 * {@link MAX_AST_DEPTH}.
 */
export function parseFormula(text: string): FormulaAst {
  return parse(text, false) as FormulaAst;
}

/**
 * Parses the full grammar: everything `parseFormula` accepts plus the range
 * operator between any two references (`A1:INDEX(B:B,3)`), intersection
 * (`A1:C3 B2:D5`), union (`(A1:A3,C1:C3)`) and references across a span of
 * sheets (`Jan:Mar!B2`). The result may hold `refop` and `ref3d` nodes.
 */
export function parseFormulaExtended(text: string): ExtendedAst {
  return parse(text, true);
}
