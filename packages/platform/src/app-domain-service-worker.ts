const APP_DOMAIN_SAFE_SERVICE_WORKER = `
const VERSION = "app-v1";
const CACHE_STATIC = "matrix-os-static-" + VERSION;

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith("matrix-os-static-") && key !== CACHE_STATIC)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

function isBypassed(url) {
  if (url.origin !== self.location.origin) return true;
  const p = url.pathname;
  return (
    p.startsWith("/api/") ||
    p.startsWith("/v1/") ||
    p.startsWith("/clerk") ||
    p.startsWith("/_clerk") ||
    p.startsWith("/__clerk") ||
    p.startsWith("/__session") ||
    p.startsWith("/sign-in") ||
    p.startsWith("/sign-up") ||
    p.startsWith("/vm/") ||
    p.startsWith("/files/apps/") ||
    p.includes("/__nextjs_") ||
    p.startsWith("/_next/data/")
  );
}

function isStaticAsset(url) {
  const p = url.pathname;
  return (
    p.startsWith("/_next/static/") ||
    p.startsWith("/icons/") ||
    p.startsWith("/wallpapers/") ||
    p.startsWith("/files/system/wallpapers/") ||
    p.startsWith("/textures/") ||
    p.startsWith("/fonts/") ||
    /\\.(?:png|jpg|jpeg|svg|webp|woff2?|ttf|css|js|wav|mp3)$/.test(p)
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (isBypassed(url) || !isStaticAsset(url)) return;
  event.respondWith(cacheFirst(req));
});

async function cacheFirst(req) {
  const cache = await caches.open(CACHE_STATIC);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req, { signal: AbortSignal.timeout(30000) });
    if (res.ok && res.type === "basic") {
      cache.put(req, res.clone()).catch((err) => {
        console.warn("[app sw] static cache put failed:", err?.message ?? err);
      });
    }
    return res;
  } catch (_err) {
    return new Response("offline", {
      status: 504,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }
}
`.trim();

export function appDomainServiceWorkerResponse(): Response {
  return new Response(APP_DOMAIN_SAFE_SERVICE_WORKER, {
    status: 200,
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-store, private',
      'cdn-cache-control': 'no-store',
      'cloudflare-cdn-cache-control': 'no-store',
      'pragma': 'no-cache',
      'expires': '0',
      'service-worker-allowed': '/',
    },
  });
}
