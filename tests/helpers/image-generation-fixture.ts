import { deflateSync } from "node:zlib";
function chunk(type: string, body: Buffer): Buffer {
    const result = Buffer.alloc(body.length + 12);
    result.writeUInt32BE(body.length);
    result.write(type, 4);
    body.copy(result, 8);
    let crc = 0xffffffff;
    for (const byte of result.subarray(4, body.length + 8)) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++)
            crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, body.length + 8);
    return result;
}
const header = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
export const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk("IEND", Buffer.alloc(0))]).toString("base64");
export const providerResponse = () => ({ status: "completed", steps: [{ type: "model_output", content: [{ type: "image", mime_type: "image/png", data: png }] }], usage: { total_input_tokens: 10, total_output_tokens: 1120, total_thought_tokens: 0, total_cached_tokens: 0, total_tool_use_tokens: 0, total_tokens: 1130, input_tokens_by_modality: [{ modality: "text", tokens: 10 }], output_tokens_by_modality: [{ modality: "image", tokens: 1120 }] } });
export function widePngFixture(width: number, height: number, level = 9): string {
    const ihdr = Buffer.from(header);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[9] = 0;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.alloc((width + 1) * height), { level })), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}
