export const MAX_FRAME_BYTES = 128 * 1024;
const MAX_JSON_DEPTH = 128;
const MAX_OBJECT_KEYS = 4_096;
function fail(code: string): never {
  throw new Error(code);
}
class UniqueJsonKeyParser {
  private offset = 0;
  constructor(private readonly text: string) {}
  validate(): void {
    this.skipWhitespace();
    this.parseValue();
    this.skipWhitespace();
    if (this.offset !== this.text.length) fail('frame_invalid_json');
  }
  private parseValue(depth = 0): void {
    if (depth > MAX_JSON_DEPTH) fail('frame_too_complex');
    this.skipWhitespace();
    const token = this.text[this.offset];
    if (token === '{') return this.parseObject(depth);
    if (token === '[') return this.parseArray(depth);
    if (token === '"') {
      this.parseString();
      return;
    }
    if (this.text.startsWith('true', this.offset)) {
      this.offset += 4;
      return;
    }
    if (this.text.startsWith('false', this.offset)) {
      this.offset += 5;
      return;
    }
    if (this.text.startsWith('null', this.offset)) {
      this.offset += 4;
      return;
    }
    this.parseNumber();
  }
  private parseObject(depth: number): void {
    this.offset += 1;
    this.skipWhitespace();
    const keys = new Set<string>();
    if (this.text[this.offset] === '}') {
      this.offset += 1;
      return;
    }
    while (this.offset < this.text.length) {
      if (this.text[this.offset] !== '"') fail('frame_invalid_json');
      const key = this.parseString();
      if (keys.has(key)) fail('frame_duplicate_key');
      if (keys.size >= MAX_OBJECT_KEYS) fail('frame_too_complex');
      keys.add(key);
      this.skipWhitespace();
      if (this.text[this.offset] !== ':') fail('frame_invalid_json');
      this.offset += 1;
      this.parseValue(depth + 1);
      this.skipWhitespace();
      const token = this.text[this.offset];
      if (token === '}') {
        this.offset += 1;
        return;
      }
      if (token !== ',') fail('frame_invalid_json');
      this.offset += 1;
      this.skipWhitespace();
    }
    fail('frame_invalid_json');
  }
  private parseArray(depth: number): void {
    this.offset += 1;
    this.skipWhitespace();
    if (this.text[this.offset] === ']') {
      this.offset += 1;
      return;
    }
    while (this.offset < this.text.length) {
      this.parseValue(depth + 1);
      this.skipWhitespace();
      const token = this.text[this.offset];
      if (token === ']') {
        this.offset += 1;
        return;
      }
      if (token !== ',') fail('frame_invalid_json');
      this.offset += 1;
    }
    fail('frame_invalid_json');
  }
  private parseString(): string {
    const start = this.offset;
    this.offset += 1;
    while (this.offset < this.text.length) {
      const token = this.text[this.offset];
      if (token === '"') {
        this.offset += 1;
        try {
          return JSON.parse(this.text.slice(start, this.offset)) as string;
        } catch (error: unknown) {
          if (error instanceof SyntaxError) fail('frame_invalid_json');
          throw error;
        }
      }
      if (token === '\\') {
        this.offset += 1;
        const escaped = this.text[this.offset];
        if (escaped === 'u') {
          const digits = this.text.slice(this.offset + 1, this.offset + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(digits)) fail('frame_invalid_json');
          this.offset += 5;
          continue;
        }
        if (!'"\\/bfnrt'.includes(escaped ?? '')) fail('frame_invalid_json');
        this.offset += 1;
        continue;
      }
      if (token === undefined || token.charCodeAt(0) < 0x20) fail('frame_invalid_json');
      this.offset += 1;
    }
    fail('frame_invalid_json');
  }
  private parseNumber(): void {
    const match = this.text.slice(this.offset).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) fail('frame_invalid_json');
    this.offset += match[0].length;
  }
  private skipWhitespace(): void {
    while (/[\t\n\r ]/.test(this.text[this.offset] ?? '')) this.offset += 1;
  }
}
export function parseUniqueJson(text: string): unknown {
  new UniqueJsonKeyParser(text).validate();
  try {
    return JSON.parse(text) as unknown;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) fail('frame_invalid_json');
    throw error;
  }
}
export function encodeFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  if (payload.byteLength > MAX_FRAME_BYTES) fail('frame_too_large');
  const frame = Buffer.allocUnsafe(payload.byteLength + 4);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}
export function decodeFrame(input: Uint8Array): unknown {
  const frame = Buffer.from(input);
  if (frame.byteLength < 4) fail('frame_incomplete');
  const length = frame.readUInt32BE(0);
  if (length > MAX_FRAME_BYTES) fail('frame_too_large');
  if (frame.byteLength < length + 4) fail('frame_incomplete');
  if (frame.byteLength !== length + 4) fail('frame_trailing_bytes');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(frame.subarray(4));
  } catch (error: unknown) {
    if (error instanceof TypeError) fail('frame_invalid_utf8');
    throw error;
  }
  return parseUniqueJson(text);
}
