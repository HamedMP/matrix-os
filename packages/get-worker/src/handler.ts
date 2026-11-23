const INSTALLER_PATHS = new Set(["/", "/install.sh"]);

const BASE_HEADERS = {
  "content-type": "text/plain; charset=utf-8",
  "x-content-type-options": "nosniff",
};

/**
 * Builds the request handler for get.matrix-os.com. People pipe the response
 * straight into `sh`, so the only body that may look like a script is the
 * installer itself, and a bundle without it must fail at startup rather than
 * serve something else.
 */
export function createInstallerHandler(script: string): (request: Request) => Response {
  if (!script.startsWith("#!/bin/sh\n")) {
    throw new Error("Matrix installer script is missing from the Worker bundle");
  }
  const contentLength = String(new TextEncoder().encode(script).length);

  return (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed\n", {
        status: 405,
        headers: { ...BASE_HEADERS, allow: "GET, HEAD" },
      });
    }
    if (!INSTALLER_PATHS.has(new URL(request.url).pathname)) {
      return new Response("Not found. Install with: curl -fsSL https://get.matrix-os.com | sh\n", {
        status: 404,
        headers: BASE_HEADERS,
      });
    }
    return new Response(request.method === "HEAD" ? null : script, {
      status: 200,
      headers: {
        ...BASE_HEADERS,
        "cache-control": "public, max-age=300",
        // Cloudflare ignores cache-control overrides from origin rules; state
        // its policy separately so a deploy is visible at the edge at once.
        "cdn-cache-control": "no-store",
        "content-length": contentLength,
      },
    });
  };
}
