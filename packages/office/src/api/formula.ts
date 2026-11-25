/**
 * Contract: spreadsheet formula parser and evaluator.
 * Implemented by `src/xlsx/formula/index.ts`.
 *
 * Type-only. Each function type is implemented as a value export with the
 * camelCase name given in {@link FormulaModule}.
 *
 * Rows and columns are zero-based everywhere: `A1` is row 0, column 0.
 * Sheets are named by their sheet name, compared without regard to case.
 * A formula that cannot be parsed throws `OfficeError("formula_error")`;
 * a formula that fails while evaluating returns a {@link FormulaError} value.
 */

export type FormulaErrorCode = "#DIV/0!" | "#VALUE!" | "#REF!" | "#NAME?" | "#N/A" | "#NUM!" | "#NULL!";

/** An error value. It propagates through operators and most functions. */
export interface FormulaError {
  kind: "error";
  code: FormulaErrorCode;
  /** Explanation for logs and tooltips, never shown in the cell. */
  message?: string;
}

/** A single value. `null` is an empty cell. Dates are serial numbers. */
export type FormulaScalar = number | string | boolean | null | FormulaError;

/** Inclusive, zero-based bounds of a rectangle on one sheet. */
export interface RangeBounds {
  sheet: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/**
 * A rectangle of values: a range read from a sheet, an array constant or the
 * result of an array function. `values` has `rows` rows of `cols` scalars.
 */
export interface FormulaArray {
  kind: "array";
  rows: number;
  cols: number;
  values: FormulaScalar[][];
  /**
   * The sheet range the values were read from, or null for a computed array.
   * A whole-column or whole-row reference keeps its full bounds here while
   * `values` covers only the used part of the sheet.
   */
  ref: RangeBounds | null;
}

export type FormulaValue = FormulaScalar | FormulaArray;

export type UnaryOperator = "+" | "-" | "%";
export type BinaryOperator = "+" | "-" | "*" | "/" | "^" | "&" | "=" | "<>" | "<" | ">" | "<=" | ">=";

/** One corner of a reference. */
export interface CellCorner {
  row: number;
  col: number;
  /** True when written with `$`: the row does not shift when the formula is moved. */
  rowAbsolute: boolean;
  colAbsolute: boolean;
}

export interface NumberNode {
  type: "number";
  value: number;
}
export interface StringNode {
  type: "string";
  value: string;
}
export interface BooleanNode {
  type: "boolean";
  value: boolean;
}
export interface ErrorNode {
  type: "error";
  code: FormulaErrorCode;
}
/** `A1`, `$B$2`, `Sheet2!C3`, `'My sheet'!C3`. */
export interface CellNode extends CellCorner {
  type: "cell";
  /** Sheet name as written without quotes, or null for the formula's own sheet. */
  sheet: string | null;
}
/**
 * `A1:B2`, `Sheet2!A1:B2`, `A:C`, `2:5`.
 * For `columns` the rows are 0 and the last row of a sheet; for `rows` the
 * columns are 0 and the last column.
 */
export interface RangeNode {
  type: "range";
  sheet: string | null;
  shape: "cells" | "columns" | "rows";
  start: CellCorner;
  end: CellCorner;
}
/** A defined name, for example `TaxRate`. */
export interface NameNode {
  type: "name";
  name: string;
  sheet: string | null;
}
export interface UnaryNode {
  type: "unary";
  op: UnaryOperator;
  operand: FormulaAst;
}
export interface BinaryNode {
  type: "binary";
  op: BinaryOperator;
  left: FormulaAst;
  right: FormulaAst;
}
/** A function call. `name` is upper case without the `_xlfn.` prefix. */
export interface CallNode {
  type: "call";
  name: string;
  args: FormulaAst[];
}
/** An argument left empty, as the second one in `IF(A1,,2)`. */
export interface MissingNode {
  type: "missing";
}
/** An array constant: `{1,2;3,4}` is two rows of two. */
export interface ArrayNode {
  type: "array";
  rows: FormulaAst[][];
}
/** Parentheses, kept so that a formula can be written back as it was. */
export interface ParenNode {
  type: "paren";
  inner: FormulaAst;
}

export type ReferenceNode = CellNode | RangeNode;

export type FormulaAst =
  | NumberNode
  | StringNode
  | BooleanNode
  | ErrorNode
  | CellNode
  | RangeNode
  | NameNode
  | UnaryNode
  | BinaryNode
  | CallNode
  | MissingNode
  | ArrayNode
  | ParenNode;

/** How a defined name resolves. */
export type NameResolution =
  /** A formula, usually a reference. Unqualified references in it belong to `sheet`. */
  | { kind: "formula"; ast: FormulaAst; sheet: string }
  | { kind: "value"; value: FormulaValue };

/**
 * The data an evaluation reads. Implemented by the workbook; a test can pass
 * a small object.
 */
export interface CellProvider {
  /** Current value of a cell. An unknown sheet gives a `#REF!` error value. */
  getCellValue(sheet: string, row: number, col: number): FormulaScalar;
  /**
   * Values of a rectangle, row by row. The rectangle is clipped to the used
   * range of the sheet, so a whole-column reference returns only the used
   * rows; the result may be smaller than the bounds and may be empty.
   * An unknown sheet gives a `#REF!` error value.
   */
  getRangeValues(bounds: RangeBounds): FormulaScalar[][] | FormulaError;
  /** A defined name as seen from `sheet` (sheet scope wins over workbook scope), or null when undefined. */
  resolveName(name: string, sheet: string): NameResolution | null;
}

/** An argument as an eager function receives it: evaluated, with ranges as arrays. */
export type FormulaArg = FormulaValue;

export interface FunctionContext {
  provider: CellProvider;
  /**
   * The cell being calculated. While a sheet-local defined name is
   * evaluated, `sheet` is the name's own sheet, not the caller's.
   */
  sheet: string;
  row: number;
  col: number;
  /** ISO 8601 time for NOW and TODAY, supplied by the caller. Without it they return `#N/A`. */
  now: string | null;
  /** True for the 1904 date system. */
  date1904: boolean;
  /** Source of randomness for RAND; `Math.random` when the caller gives none. */
  random: () => number;
  /**
   * Formats a value with a number format code, for TEXT. Supplied by the
   * workbook; null when the caller gave none, in which case TEXT falls back
   * to the general format.
   */
  formatValue: ((value: FormulaScalar, formatCode: string) => string) | null;
  /** Evaluates a node in this context. For lazy functions. */
  evaluate(node: FormulaAst): FormulaValue;
}

/** An ordinary function: arguments are evaluated before the call. A missing argument arrives as `null`. */
export type FunctionImpl = (args: readonly FormulaArg[], context: FunctionContext) => FormulaValue;

/** A function that decides which arguments to evaluate (IF, IFERROR, CHOOSE) or needs the reference itself (ROW, OFFSET). */
export type LazyFunctionImpl = (args: readonly FormulaAst[], context: FunctionContext) => FormulaValue;

export interface FunctionOptions {
  /** Fewer arguments give `#VALUE!` without calling the function. Default 0. */
  minArgs?: number;
  /** More arguments give `#VALUE!` without calling the function. Default: no maximum. */
  maxArgs?: number;
  /** True when the result can change without an input changing (NOW, RAND). */
  volatile?: boolean;
}

export interface RegisteredFunctionBase {
  /** Upper case. */
  name: string;
  minArgs: number;
  /** Null for no maximum. */
  maxArgs: number | null;
  volatile: boolean;
}

export type RegisteredFunction =
  | (RegisteredFunctionBase & { lazy: false; impl: FunctionImpl })
  | (RegisteredFunctionBase & { lazy: true; impl: LazyFunctionImpl });

/** Functions by name. Names are case-insensitive and stored in upper case. */
export interface FunctionRegistry {
  /** Registers or replaces a function. */
  register(name: string, impl: FunctionImpl, options?: FunctionOptions): void;
  registerLazy(name: string, impl: LazyFunctionImpl, options?: FunctionOptions): void;
  get(name: string): RegisteredFunction | null;
  has(name: string): boolean;
  /** Registered names in upper case, sorted. */
  names(): string[];
}

export interface EvalContext {
  provider: CellProvider;
  functions: FunctionRegistry;
  /** Sheet and cell that hold the formula. */
  sheet: string;
  row: number;
  col: number;
  now?: string | null;
  date1904?: boolean;
  random?: () => number;
  formatValue?: ((value: FormulaScalar, formatCode: string) => string) | null;
  /** Maximum nesting of names and function calls before `#NUM!`. Default 256. */
  maxDepth?: number;
}

/**
 * Parses a formula with or without the leading `=`.
 *
 * Supported: numbers, strings, booleans, error literals, cell and range
 * references with optional sheet, whole columns and rows, defined names,
 * the operators in {@link UnaryOperator} and {@link BinaryOperator} with
 * spreadsheet precedence, function calls and array constants.
 * Not supported (`formula_error`): the union and intersection operators,
 * references across several sheets, references to other workbooks and
 * structured table references. (`parseFormulaExtended` of
 * `src/xlsx/formula/index.ts` accepts the reference operators and
 * references across a span of sheets, with tree nodes of its own.)
 *
 * Throws `formula_error` with `details.offset`, and `limit_exceeded` for a
 * formula longer than 8192 characters.
 */
export type ParseFormula = (text: string) => FormulaAst;

/**
 * Writes a formula back as text without the leading `=`. Function names are
 * upper case, sheet names are quoted when needed, and
 * `serializeFormula(parseFormula(x))` parses to the same tree.
 */
export type SerializeFormula = (ast: FormulaAst) => string;

/**
 * Evaluates a formula. Never throws for a calculation problem: division by
 * zero, a wrong type, an unknown name or function are error values
 * (`#DIV/0!`, `#VALUE!`, `#NAME?`). A reference result is returned as a
 * {@link FormulaArray} with `ref` set; the caller picks the cell it needs.
 */
export type Evaluate = (ast: FormulaAst, context: EvalContext) => FormulaValue;

/** Every cell, range and name node of a formula in source order, for dependency tracking. */
export type CollectReferences = (ast: FormulaAst) => Array<ReferenceNode | NameNode>;

/**
 * Returns a copy of the tree with each reference node replaced by what the
 * callback returns (the same node to keep it, an `ErrorNode` with `#REF!` for
 * a deleted target). Used to shift references when rows, columns or sheets change.
 */
export type MapReferences = (ast: FormulaAst, map: (node: ReferenceNode) => FormulaAst) => FormulaAst;

/**
 * Creates a registry. With `builtins` (default true) it holds the function
 * library, which covers at least:
 * SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, COUNTBLANK, PRODUCT, SUMPRODUCT,
 * SUMIF, SUMIFS, COUNTIF, COUNTIFS, AVERAGEIF, AVERAGEIFS, MEDIAN,
 * IF, IFS, IFERROR, IFNA, AND, OR, NOT, XOR, TRUE, FALSE, SWITCH, CHOOSE,
 * ABS, ROUND, ROUNDUP, ROUNDDOWN, INT, TRUNC, MOD, POWER, SQRT, EXP, LN, LOG, LOG10, SIGN, CEILING, FLOOR, PI, RAND,
 * VLOOKUP, HLOOKUP, XLOOKUP, INDEX, MATCH, ROW, COLUMN, ROWS, COLUMNS,
 * CONCATENATE, CONCAT, TEXTJOIN, LEFT, RIGHT, MID, LEN, TRIM, UPPER, LOWER, PROPER, FIND, SEARCH, SUBSTITUTE, REPLACE, REPT, TEXT, VALUE, EXACT,
 * DATE, YEAR, MONTH, DAY, WEEKDAY, TODAY, NOW, EDATE, EOMONTH, DAYS, DATEDIF,
 * ISBLANK, ISNUMBER, ISTEXT, ISLOGICAL, ISERROR, ISERR, ISNA, NA,
 * PMT, PV, FV, NPV, IRR.
 *
 * There is no `#CALC!` error value: an empty result of FILTER, UNIQUE or
 * SORT is `#VALUE!`. INDEX reads the first area only, INDIRECT reads A1
 * notation only, and SUBTOTAL and AGGREGATE do not skip hidden rows.
 */
export type CreateFunctionRegistry = (options?: { builtins?: boolean }) => FunctionRegistry;

/** The value exports of `src/xlsx/formula/index.ts`. */
export interface FormulaModule {
  parseFormula: ParseFormula;
  serializeFormula: SerializeFormula;
  evaluate: Evaluate;
  collectReferences: CollectReferences;
  mapReferences: MapReferences;
  createFunctionRegistry: CreateFunctionRegistry;
}
