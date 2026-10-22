import { expect, it } from "vitest";
import { validateBotImageInferenceBody, BOT_INPUT_IMAGE_MAX_BYTES } from "@matrix-os/contracts";
const data = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(400 * 1024)]).toString("base64");
const body = (url = `data:image/png;base64,${data}`, text = "Inspect") => JSON.stringify({ model: "gpt-6.1-sol", stream: true, input: [{ role: "user", content: [{ type: "input_text", text }, { type: "input_image", image_url: url, detail: "auto" }] }] });
it("accepts bounded native SDK data-url images above the old text-only cap", () => {
  expect(validateBotImageInferenceBody(body())).toMatchObject({ valid: true, imageCount: 1 });
});
it.each([
  body("https://remote.invalid/photo.png"), body("data:image/gif;base64,AAAA"), body("data:image/png;base64,????"),
  body(`data:image/png;base64,${Buffer.alloc(BOT_INPUT_IMAGE_MAX_BYTES + 1).toString("base64")}`),
  body(undefined, "x".repeat(256 * 1024)),
  JSON.stringify({ model: "gpt", input: [{ role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${data}`, unknown: true }] }] }),
  JSON.stringify({ model: "gpt", arbitrary: { type: "input_image", image_url: `data:image/png;base64,${data}` } }),
  JSON.stringify({ model: "gpt", input: [{ role: "user", content: Array.from({ length: 5 }, () => ({ type: "input_image", image_url: `data:image/png;base64,${data}` })) }] }),
])("rejects remote, malformed, unsupported, oversized and unknown image envelopes", value => {
  expect(validateBotImageInferenceBody(value).valid).toBe(false);
});
it("keeps the existing text bound and enforces depth without broad transport relaxation", () => {
  expect(validateBotImageInferenceBody(JSON.stringify({ model: "gpt", messages: [{ role: "user", content: "hello" }] }))).toMatchObject({ valid: true, imageCount: 0 });
  expect(validateBotImageInferenceBody(JSON.stringify({ model: "gpt", payload: "x".repeat(300 * 1024) })).valid).toBe(false);
  let nested: unknown = "a"; for (let i = 0; i < 40; i++) nested = { child: nested };
  expect(validateBotImageInferenceBody(JSON.stringify({ model: "gpt", nested })).valid).toBe(false);
});
it("counts raw whitespace and image escaping against the unchanged nonimage byte budget", () => {
  expect(validateBotImageInferenceBody(" ".repeat(300 * 1024) + "{}").valid).toBe(false);
  expect(validateBotImageInferenceBody(" ".repeat(300 * 1024) + body()).valid).toBe(false);
});
it("rejects a declared MIME whose actual base64 signature differs", () => {
  expect(validateBotImageInferenceBody(body(`data:image/jpeg;base64,${data}`)).valid).toBe(false);
});
