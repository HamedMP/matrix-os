// Matrix OS PWA service worker.
// Strategy:
//   - HTML navigation: network-first with 3s timeout, falls back to cache.
//   - Static shell assets (/_next/static/*, /icons/*, manifest, app icons,
//     wallpapers, textures, fonts): cache-first.
//   - Skip everything authenticated/dynamic: /api/*, /v1/*, Clerk, gateway
//     WebSocket upgrades, explicit /vm/* runtime shells, anything cross-origin
//     we don't serve.
// On version bump, old caches are pruned during activate.

const VERSION = "v3";
const CACHE_STATIC = `matrix-os-static-${VERSION}`;
const CACHE_HTML = `matrix-os-html-${VERSION}`;
const PRECACHE = [
  "/",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/apple-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_STATIC).then((cache) =>
      Promise.all(
        PRECACHE.map((url) =>
          fetch(url, { credentials: "same-origin", signal: AbortSignal.timeout(10_000) })
            .then((res) => (res.ok ? cache.put(url, res.clone()) : null))
            .catch((err) => {
              console.warn("[sw] precache failed for", url, err?.message ?? err);
              return null;
            }),
        ),
      ),
    ),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.flatMap((k) =>
          k !== CACHE_STATIC && k !== CACHE_HTML ? [caches.delete(k)] : [],
        ),
      ),
    ).then(() => self.clients.claim()),
  );
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
    /\.(?:png|jpg|jpeg|svg|webp|woff2?|ttf|css|js|wav|mp3)$/.test(p)
  );
}

function isShellNavigation(url) {
  const p = url.pathname;
  return p === "/";
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (isBypassed(url)) return;

  if ((req.mode === "navigate" || req.headers.get("accept")?.includes("text/html")) && isShellNavigation(url)) {
    event.respondWith(networkFirstHtml(req));
    return;
  }

  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(req));
  }
});

async function networkFirstHtml(req) {
  const cache = await caches.open(CACHE_HTML);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(req, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      cache.put(req, res.clone()).catch((err) => {
        console.warn("[sw] html cache put failed:", err?.message ?? err);
      });
    }
    return res;
  } catch (err) {
    console.warn("[sw] network-first fetch failed, trying cache:", err?.message ?? err);
    const cached = await cache.match(req);
    if (cached) return cached;
    const staticCache = await caches.open(CACHE_STATIC);
    const fallback = await staticCache.match("/");
    if (fallback) return fallback;
    throw new Error("offline and no cached HTML");
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE_STATIC);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req, { signal: AbortSignal.timeout(30_000) });
    if (res.ok && res.type === "basic") {
      cache.put(req, res.clone()).catch((err) => {
        console.warn("[sw] static cache put failed:", err?.message ?? err);
      });
    }
    return res;
  } catch (err) {
    console.warn("[sw] static fetch failed:", err?.message ?? err);
    return new Response("offline", {
      status: 504,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }
}

self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") self.skipWaiting();
});
