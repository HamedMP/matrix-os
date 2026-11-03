import { StringDecoder } from "node:string_decoder";

/** Bounds one protocol frame, including an unfinished frame across chunks.
 * Complete frames are consumed immediately; lifetime output is not retained. */
export function createBoundedCliLines(maxFrameBytes: number, consume: (line: string) => void) {
  let decoder = new StringDecoder("utf8");
  let buffered = "";
  let pendingBytes = 0;
  const append = (bytes: Buffer) => {
    if (pendingBytes + bytes.byteLength > maxFrameBytes) throw new RangeError("Provider CLI frame exceeded limit");
    pendingBytes += bytes.byteLength;
    buffered += decoder.write(bytes);
  };
  const flush = () => {
    const line = buffered + decoder.end();
    buffered = "";
    pendingBytes = 0;
    decoder = new StringDecoder("utf8");
    if (line.trim()) consume(line);
  };
  return {
    push(chunk: Buffer) {
      let start = 0;
      for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
        append(chunk.subarray(start, end));
        flush();
        start = end + 1;
      }
      append(chunk.subarray(start));
    },
    finish: flush,
  };
}
