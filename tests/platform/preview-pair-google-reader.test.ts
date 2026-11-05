import { describe, expect, it, vi } from "vitest";
import { createPreviewPairGoogleReader } from "../../packages/platform/src/preview-pair/google-reader.js";

const binding = { ref: "matrix-preview-host", version: "4" }, projectNumber = "123456789012";
const resource = `projects/${projectNumber}/secrets/${binding.ref}/versions/${binding.version}`;
function setup(override: Record<string, unknown> = {}) {
  const fetchImpl = vi.fn<typeof fetch>(async input => {
    if (String(input).startsWith("http://metadata.google.internal/")) return Response.json({ access_token: "fixture-google-token",
      token_type: "Bearer", expires_in: 3600 }, { headers: { "metadata-flavor": "Google" } });
    return Response.json({ name: resource, payload: { data: Buffer.from("123456789").toString("base64"),
      dataCrc32c: String(Number.parseInt("e3069283", 16)) }, ...override });
  });
  return { fetchImpl, reader: createPreviewPairGoogleReader({ projectNumber, fetchImpl }) };
}

describe("fixed Google metadata and pinned Secret Manager producer", () => {
  it("obtains only the attached service account token and verifies the pinned secret bytes", async () => {
    const { reader, fetchImpl } = setup();
    expect(await reader.secret(binding, AbortSignal.timeout(1_000))).toBe("123456789");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [metadata, secret] = fetchImpl.mock.calls;
    expect(String(metadata[0])).toBe("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token");
    expect(new Headers(metadata[1]?.headers).get("metadata-flavor")).toBe("Google");
    expect(new Headers(metadata[1]?.headers).has("authorization")).toBe(false);
    expect(String(secret[0])).toBe(`https://secretmanager.googleapis.com/v1/${resource}:access`);
    expect(new Headers(secret[1]?.headers).get("authorization")).toBe("Bearer fixture-google-token");
    for (const call of fetchImpl.mock.calls) { expect(call[1]?.redirect).toBe("error"); expect(call[1]?.signal).toBeInstanceOf(AbortSignal); }
  });
  it.each(["foreign version", "bad checksum", "missing checksum", "invalid base64", "invalid UTF8"])("rejects %s", async fault => {
    const payload: Record<string, unknown> = { data: Buffer.from("123456789").toString("base64"), dataCrc32c: String(Number.parseInt("e3069283", 16)) };
    if (fault === "bad checksum") payload.dataCrc32c = "0";
    if (fault === "missing checksum") delete payload.dataCrc32c;
    if (fault === "invalid base64") payload.data = "not-base64";
    if (fault === "invalid UTF8") { payload.data = "/w=="; payload.dataCrc32c = "4278190080"; }
    const { reader } = setup({ name: fault === "foreign version" ? resource.replace("/4", "/5") : resource, payload });
    await expect(reader.secret(binding, AbortSignal.timeout(1_000))).rejects.toThrow("unavailable");
  });
  it("denies a latest alias or path injection before contacting any API", async () => {
    const { reader, fetchImpl } = setup();
    for (const changed of [{ ...binding, version: "latest" }, { ...binding, ref: "../production" }]) {
      await expect(reader.secret(changed, AbortSignal.timeout(1_000))).rejects.toThrow("unavailable");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("preserves cancellation and keeps provider errors generic", async () => {
    const { reader, fetchImpl } = setup(), aborted = AbortSignal.abort();
    await expect(reader.secret(binding, aborted)).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
    fetchImpl.mockResolvedValue(Response.json({ error: "private operator diagnostic" }, { status: 403 }));
    await expect(reader.accessToken(AbortSignal.timeout(1_000))).rejects.toThrow("unavailable");
  });
});
