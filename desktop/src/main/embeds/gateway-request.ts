// Owner-authenticated request to the runtime gateway through Electron's net
// stack (bearer attached here, never by a renderer), with a 10 s timeout.
import { net } from "electron";

export function requestGateway(
  token: string | null,
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
): Promise<{ status: number; setCookieHeaders: string[]; body: string }> {
  return new Promise((resolve, reject) => {
    const request = net.request({ method: init.method, url });
    for (const [key, value] of Object.entries(init.headers)) request.setHeader(key, value);
    if (token) request.setHeader("Authorization", `Bearer ${token}`);
    const timeout = setTimeout(() => {
      request.abort();
      reject(new Error("gateway request timed out"));
    }, 10_000);
    request.on("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      response.on("end", () => {
        clearTimeout(timeout);
        const rawSetCookie = response.headers["set-cookie"];
        const setCookieHeaders = Array.isArray(rawSetCookie)
          ? rawSetCookie
          : typeof rawSetCookie === "string"
            ? [rawSetCookie]
            : [];
        resolve({
          status: response.statusCode,
          setCookieHeaders,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    request.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    request.end(init.body);
  });
}