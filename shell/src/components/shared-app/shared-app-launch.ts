/** Stable desktop app scheme; Canary registers its own (desktop channel identity). */
export const SHARED_APP_DESKTOP_SCHEME = "matrixos";

/**
 * JSON string literal that is safe inside an inline `<script>`: `<`, `>`, `&`
 * and the JS line separators are escaped, so no value can close the element or
 * open an HTML comment.
 */
export function inlineScriptString(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
