/** Browser-only utilities. Nothing in this module sends tool input to a server. */
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const jwtAlgorithms = {
  HS256: { name: "HMAC", hash: "SHA-256", kind: "secret" },
  HS384: { name: "HMAC", hash: "SHA-384", kind: "secret" },
  HS512: { name: "HMAC", hash: "SHA-512", kind: "secret" },
  RS256: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", kind: "public" },
  RS384: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-384", kind: "public" },
  RS512: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-512", kind: "public" },
};

function base64urlBytes(input) {
  if (!/^[A-Za-z0-9_-]+$/.test(input)) throw new Error("JWT has invalid Base64URL content.");
  try {
    const padded = input.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch { throw new Error("JWT has invalid Base64URL content."); }
}

function jsonObject(input, label) {
  let value;
  try { value = JSON.parse(decoder.decode(base64urlBytes(input))); }
  catch { throw new Error(`JWT ${label} must contain valid UTF-8 JSON.`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`JWT ${label} must be a JSON object.`);
  return value;
}

export function decodeJwt(token) {
  if (typeof token !== "string" || token.length > 16_384) throw new Error("JWT is too large (maximum 16 KB).");
  const value = token.trim();
  const parts = value.split(".");
  if (parts.length !== 3) throw new Error("A JWT needs three parts separated by dots.");
  const [encodedHeader, encodedPayload, signature] = parts;
  if (!encodedHeader || !encodedPayload) throw new Error("JWT header and payload are required.");
  const header = jsonObject(encodedHeader, "header");
  const payload = jsonObject(encodedPayload, "payload");
  if (header.alg === "none" || !signature) throw new Error("Unsigned JWTs cannot be verified here.");
  if (typeof header.alg !== "string") throw new Error("JWT header must name a signature algorithm.");
  base64urlBytes(signature);
  return { header, payload, signaturePresent: true, verified: false };
}

function parsePublicKey(input) {
  if (!/-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----/.test(input)) throw new Error("Paste an SPKI PEM public key for RSA verification.");
  const body = input.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g, "");
  try { return Uint8Array.from(atob(body), (character) => character.charCodeAt(0)); }
  catch { throw new Error("The PEM public key is invalid."); }
}

/** Signature verification is separate from decoding, and never accepts an algorithm from key material. */
export async function verifyJwt(token, keyText, nowSeconds = Date.now() / 1000) {
  const { header, payload } = decodeJwt(token);
  const selected = Object.hasOwn(jwtAlgorithms, header.alg) ? jwtAlgorithms[header.alg] : undefined;
  if (!selected) throw new Error("This JWT signature algorithm is unsupported. Use HS256/384/512 or RS256/384/512.");
  if (header.crit !== undefined) throw new Error("JWT critical extensions are unsupported.");
  if (typeof keyText !== "string" || !keyText || keyText.length > 16_384) throw new Error("Enter a secret or public key of up to 16 KB.");
  if (!Number.isFinite(nowSeconds)) throw new Error("The current time is invalid.");
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("This browser does not support secure signature verification.");
  let key;
  try {
    key = selected.kind === "secret"
      ? await subtle.importKey("raw", encoder.encode(keyText), { name: selected.name, hash: selected.hash }, false, ["verify"])
      : await subtle.importKey("spki", parsePublicKey(keyText), { name: selected.name, hash: selected.hash }, false, ["verify"]);
  } catch { throw new Error(selected.kind === "secret" ? "Could not use that verification secret." : "Could not import that RSA public key."); }
  const [encodedHeader, encodedPayload, encodedSignature] = token.trim().split(".");
  const signatureValid = await subtle.verify({ name: selected.name }, key, base64urlBytes(encodedSignature), encoder.encode(`${encodedHeader}.${encodedPayload}`));
  if (!signatureValid) return { signatureValid: false, claimsValid: false, status: "Invalid signature" };
  for (const claim of ["exp", "nbf", "iat"]) if (claim in payload && (!Number.isFinite(payload[claim]) || typeof payload[claim] !== "number")) throw new Error(`JWT ${claim} claim must be a Unix timestamp in seconds.`);
  if (payload.exp !== undefined && nowSeconds >= payload.exp) return { signatureValid: true, claimsValid: false, status: "Valid signature; token expired" };
  if (payload.nbf !== undefined && nowSeconds < payload.nbf) return { signatureValid: true, claimsValid: false, status: "Valid signature; token not valid yet" };
  return { signatureValid: true, claimsValid: true, status: "Valid signature and time claims" };
}

const characterSets = {
  lower: "abcdefghjkmnpqrstuvwxyz",
  upper: "ABCDEFGHJKMNPQRSTUVWXYZ",
  digits: "23456789",
  symbols: "!@#$%^&*()-_=+[]{}:,.?",
};

function secureIndex(max) {
  if (!globalThis.crypto?.getRandomValues) throw new Error("Secure randomness is unavailable in this browser.");
  // Rejection sampling avoids modulo bias for alphabet lengths that do not divide 256.
  const limit = 256 - (256 % max);
  const bucket = new Uint8Array(1);
  do { globalThis.crypto.getRandomValues(bucket); } while (bucket[0] >= limit);
  return bucket[0] % max;
}

export function generatePassword(options) {
  const length = Number(options?.length);
  if (!Number.isInteger(length) || length < 8 || length > 128) throw new Error("Choose a password length from 8 to 128 characters.");
  const enabled = Object.entries(characterSets).filter(([name]) => options?.[name] === true).map(([, set]) => set);
  if (!enabled.length) throw new Error("Select at least one character set.");
  const alphabet = enabled.join("");
  const result = enabled.map((set) => set[secureIndex(set.length)]);
  while (result.length < length) result.push(alphabet[secureIndex(alphabet.length)]);
  for (let index = result.length - 1; index > 0; index--) {
    const other = secureIndex(index + 1);
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result.join("");
}

let strengthFactory;
export async function assessPassword(password) {
  if (typeof password !== "string" || password.length > 1024) throw new Error("Use a password of up to 1,024 characters.");
  if (!password) throw new Error("Enter a password to assess.");
  if (!strengthFactory) {
    const [{ ZxcvbnFactory }, common, english] = await Promise.all([import("@zxcvbn-ts/core"), import("@zxcvbn-ts/language-common"), import("@zxcvbn-ts/language-en")]);
    strengthFactory = new ZxcvbnFactory({ dictionary: { ...common.dictionary, ...english.dictionary }, graphs: common.adjacencyGraphs, translations: english.translations });
  }
  const result = strengthFactory.check(password);
  const labels = ["Very weak", "Weak", "Fair", "Strong", "Very strong"];
  // Return only derived diagnostics: the entered secret never enters telemetry or output state.
  return { score: result.score, label: labels[result.score], guesses: result.guesses, warning: result.feedback?.warning || "" };
}

export async function createQrSvg(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Enter text or a URL to encode.");
  if (encoder.encode(value).length > 1024) throw new Error("QR content is limited to 1,024 UTF-8 bytes.");
  const qrcode = await import("qrcode");
  return qrcode.default.toString(value, { type: "svg", errorCorrectionLevel: "M", margin: 2, width: 512, color: { dark: "#152c24ff", light: "#ffffffff" } });
}

export async function compileCode(source, language) {
  if (typeof source !== "string" || source.length > 20_000) throw new Error("Code is limited to 20,000 characters.");
  if (!source.trim()) throw new Error("Enter code to run.");
  if (!(["javascript", "typescript"].includes(language))) throw new Error("Choose JavaScript or TypeScript.");
  const ts = await import("typescript");
  const syntax = language === "typescript" ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile("workspace-code", source, ts.ScriptTarget.ES2022, true, syntax);
  if (sourceFile.parseDiagnostics.length) throw new Error("Code has a syntax error. Check brackets, quotes, and declarations.");
  let disallowed = "";
  function inspect(node) {
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) || ts.isImportTypeNode(node) || (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "importScripts")))) disallowed = "imports";
    if (ts.isExportDeclaration(node) || ts.isExportAssignment(node) || ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) disallowed = "exports";
    ts.forEachChild(node, inspect);
  }
  inspect(sourceFile);
  if (disallowed) throw new Error(`Module ${disallowed} are unavailable in this isolated code workspace.`);
  if (language === "javascript") return source;
  const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, isolatedModules: true, removeComments: false }, reportDiagnostics: true });
  if (result.diagnostics?.some((item) => item.category === ts.DiagnosticCategory.Error)) throw new Error("TypeScript has a syntax or transpilation error.");
  return result.outputText;
}
