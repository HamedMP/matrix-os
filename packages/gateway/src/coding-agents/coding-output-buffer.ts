import { StringDecoder } from "node:string_decoder";

/** Limits one unfinished/complete protocol record, independently of run duration. */
export function createCodingOutputBuffer(maxFrameBytes: number, delimiter: "\n" | "\n\n" = "\n") {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  function assertBounded(frame: string) {
    if (Buffer.byteLength(frame, "utf8") > maxFrameBytes) throw new RangeError("Coding output frame exceeded");
  }
  return {
    push(chunk: Buffer, consume: (line: string) => void | boolean): void {
      buffer = (buffer + decoder.write(chunk)).replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf(delimiter);
      while (boundary >= 0) {
        const line = buffer.slice(0, boundary).replace(/\r$/, "");
        buffer = buffer.slice(boundary + delimiter.length);
        assertBounded(line);
        if (consume(line) === false) { buffer = ""; return; }
        boundary = buffer.indexOf(delimiter);
      }
      assertBounded(buffer);
    },
    finish(): string {
      const tail = buffer + decoder.end();
      assertBounded(tail);
      buffer = "";
      return tail;
    },
  };
}
