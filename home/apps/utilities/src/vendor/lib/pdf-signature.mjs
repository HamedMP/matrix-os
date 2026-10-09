const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_PAGES = 200;
const MAX_SIGNATURES = 4;
const MAX_CMS_BYTES = 64 * 1024;
const VERIFY_TIMEOUT_MS = 12_000;
const SUPPORTED_SUBFILTERS = new Set(["adbe.pkcs7.detached"]);
const NOTICE = "A valid cryptographic signature means the signed bytes verify using the public key in the embedded certificate. Certificate trust, signer identity, revocation, timestamps, permitted later changes, and visual PDF attacks are not checked.";

function assertPdf(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error("Choose a valid PDF file.");
  if (bytes.length > MAX_FILE_BYTES) throw new Error("Choose a PDF of 25 MB or smaller.");
  if (bytes.length < 5 || String.fromCharCode(...bytes.subarray(0, 5)) !== "%PDF-") throw new Error("Choose a valid PDF file.");
}

function safeLabel(value, fallback) {
  if (typeof value !== "string") return fallback;
  return value.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 120) || fallback;
}

function sameBytes(left, right) {
  if (!(right instanceof Uint8Array) || left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
  return true;
}

function validByteRange(bytes, range, payload) {
  if (!Array.isArray(range) || range.length !== 4 || !range.every((value) => Number.isSafeInteger(value) && value >= 0)) return false;
  const [start, firstLength, secondStart, secondLength] = range;
  if (start !== 0 || firstLength <= 0 || secondStart <= firstLength + 2 || secondLength <= 0 || secondStart + secondLength > bytes.length) return false;
  if (!Array.isArray(payload?.data) || payload.data.length !== 2 || !(payload.pkcs7 instanceof Uint8Array)) return false;
  if (!sameBytes(bytes.subarray(0, firstLength), payload.data[0]) || !sameBytes(bytes.subarray(secondStart, secondStart + secondLength), payload.data[1])) return false;
  // A valid PDF signature skips exactly its own hex-encoded /Contents value.
  if (bytes[firstLength] !== 0x3c || bytes[secondStart - 1] !== 0x3e) return false;
  const hex = new TextDecoder("ascii").decode(bytes.subarray(firstLength + 1, secondStart - 1)).replace(/[\x00\x09\x0a\x0c\x0d\x20]/g, "");
  if (!hex || hex.length % 2 || !/^[\da-fA-F]+$/.test(hex) || hex.length / 2 !== payload.pkcs7.length) return false;
  for (let i = 0; i < payload.pkcs7.length; i++) if (parseInt(hex.slice(i * 2, i * 2 + 2), 16) !== payload.pkcs7[i]) return false;
  return true;
}

async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Signature verification timed out.")), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

/** @returns {Promise<"valid" | "invalid" | "unsupported">} */
async function verifyCms(payload) {
  if (payload.pkcs7.length > MAX_CMS_BYTES) return "unsupported";
  let pkijs;
  try { pkijs = await import("pkijs"); }
  catch { return "unsupported"; }
  try {
    const cmsBytes = payload.pkcs7.buffer.slice(payload.pkcs7.byteOffset, payload.pkcs7.byteOffset + payload.pkcs7.byteLength);
    const cms = pkijs.ContentInfo.fromBER(cmsBytes);
    if (cms.contentType !== pkijs.ContentInfo.SIGNED_DATA) return "invalid";
    const signed = new pkijs.SignedData({ schema: cms.content });
    if (signed.encapContentInfo.eContentType !== pkijs.ContentInfo.DATA || "eContent" in signed.encapContentInfo) return "invalid";
    if (signed.signerInfos.length !== 1 || !signed.certificates?.length || signed.certificates.length > 20) return "unsupported";
    const data = new Uint8Array(payload.data[0].length + payload.data[1].length);
    data.set(payload.data[0]);
    data.set(payload.data[1], payload.data[0].length);
    const valid = await withTimeout(signed.verify({ signer: 0, data: data.buffer, checkChain: false }), VERIFY_TIMEOUT_MS);
    return valid ? "valid" : "invalid";
  } catch (error) {
    if (error instanceof Error && error.message === "Signature verification timed out.") return "unsupported";
    return "invalid";
  }
}

/**
 * Verifies detached CMS against PDF.js's signature byte ranges without uploading the PDF.
 * @returns {Promise<{pageCount: number, signatures: Array<{fieldName: string, subFilter: string, integrity: "valid" | "invalid" | "unsupported", coversWholeDocument: boolean, trust: "not_checked"}>, notice: string}>}
 */
export async function inspectPdfSignatures(bytes, { signal } = {}) {
  assertPdf(bytes);
  signal?.throwIfAborted();
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (typeof window !== "undefined") pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, isEvalSupported: false, enableXfa: false, stopAtErrors: true });
  try {
    const document = await task.promise;
    if (document.numPages < 1 || document.numPages > MAX_PAGES) throw new Error("PDFs must have 1 to 200 pages.");
    signal?.throwIfAborted();
    const descriptors = await document.getSignatures() ?? [];
    if (descriptors.length > MAX_SIGNATURES) throw new Error("This tool supports up to four signatures per PDF.");
    /** @type {Array<{fieldName: string, subFilter: string, integrity: "valid" | "invalid" | "unsupported", coversWholeDocument: boolean, trust: "not_checked"}>} */
    const signatures = [];
    for (const [index, descriptor] of descriptors.entries()) {
      signal?.throwIfAborted();
      const byteRange = descriptor.byteRange;
      const coversWholeDocument = Array.isArray(byteRange) && byteRange.length === 4 && byteRange[2] + byteRange[3] === bytes.length;
      const base = {
        fieldName: safeLabel(descriptor.fieldName, `Signature ${index + 1}`),
        subFilter: safeLabel(descriptor.subFilter, "Unknown"),
        coversWholeDocument,
        trust: /** @type {const} */ ("not_checked"),
      };
      if (!SUPPORTED_SUBFILTERS.has(descriptor.subFilter)) {
        signatures.push({ ...base, integrity: "unsupported" });
        continue;
      }
      const payload = await document.getSignatureData(descriptor.id);
      if (!validByteRange(bytes, byteRange, payload)) {
        signatures.push({ ...base, integrity: "invalid" });
        continue;
      }
      signatures.push({ ...base, integrity: await verifyCms(payload) });
    }
    return { pageCount: document.numPages, signatures, notice: NOTICE };
  } catch (error) {
    if (error instanceof Error && (/1 to 200 pages|four signatures/.test(error.message) || error.name === "AbortError")) throw error;
    throw new Error("Could not inspect this PDF. It may be damaged or password protected.");
  } finally {
    await task.destroy();
  }
}
