import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const RESERVED_SUBDOMAINS = new Set(["www", "api", "admin", "mail", "ftp"]);

export interface CustomerVpsProxyMachine {
  status: string;
  publicIPv4: string | null;
}

export function resolveSubdomain(host: string): string | null {
  const match = host
    .toLowerCase()
    .match(/^([a-z0-9][a-z0-9-]*)\.matrix-os\.com$/);
  if (!match) return null;
  const sub = match[1];
  if (RESERVED_SUBDOMAINS.has(sub)) return null;
  return sub;
}

export function buildCustomerVpsProxyUrl(
  machine: CustomerVpsProxyMachine,
  path: string,
  queryString = "",
): string | null {
  if (machine.status !== "running" || !machine.publicIPv4) return null;
  const safePath = path.startsWith("/") ? path : `/${path}`;
  return `https://${machine.publicIPv4}:443${safePath}${queryString}`;
}

export function isPublicProfilePath(path: string): boolean {
  if (path === "/" || path === "/profile" || path.startsWith("/profile/")) {
    return true;
  }
  return false;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

export async function createDefaultProfile(homePath: string, handle: string): Promise<void> {
  const profileDir = join(homePath, "apps", "profile");
  const indexPath = join(profileDir, "index.html");

  if (await pathExists(indexPath)) return;

  await mkdir(profileDir, { recursive: true });

  const manifest = {
    name: "Profile",
    description: `Public profile page for @${handle}`,
    runtime: "static",
    category: "social",
    version: "1.0.0",
    author: `@${handle}`,
  };

  await writeFile(
    join(profileDir, "matrix.json"),
    JSON.stringify(manifest, null, 2),
  );

  const html = generateProfileHtml(handle);
  await writeFile(indexPath, html);
}

function generateProfileHtml(handle: string): string {
  // Sanitize handle to prevent XSS in template
  const safeHandle = handle.replace(/[<>"'&]/g, "");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>@${safeHandle} - Matrix OS</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0a0a0a;
      color: #fafafa;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 3rem 1.5rem;
    }
    .profile {
      max-width: 600px;
      width: 100%;
      text-align: center;
    }
    .avatar {
      width: 96px;
      height: 96px;
      border-radius: 50%;
      background: linear-gradient(135deg, #6366f1, #a855f7);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 2.5rem;
      font-weight: bold;
      margin: 0 auto 1.5rem;
    }
    h1 { font-size: 1.75rem; font-weight: 700; margin-bottom: 0.25rem; }
    .handle { color: #a1a1aa; font-size: 0.875rem; margin-bottom: 1rem; }
    .bio { color: #d4d4d8; font-size: 1rem; line-height: 1.6; margin-bottom: 2rem; }
    .apps-section { margin-top: 2rem; }
    .apps-section h2 {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: #71717a;
      margin-bottom: 1rem;
    }
    .apps-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
      gap: 0.75rem;
    }
    .app-card {
      background: #18181b;
      border: 1px solid #27272a;
      border-radius: 12px;
      padding: 1rem;
      text-align: left;
    }
    .app-card .name { font-weight: 600; font-size: 0.875rem; }
    .app-card .desc { color: #a1a1aa; font-size: 0.75rem; margin-top: 0.25rem; }
    .powered-by {
      margin-top: 3rem;
      color: #52525b;
      font-size: 0.75rem;
    }
    .powered-by a { color: #6366f1; text-decoration: none; }
    .powered-by a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="profile">
    <div class="avatar" id="avatar"></div>
    <h1 id="display-name"></h1>
    <p class="handle" id="handle-text"></p>
    <p class="bio">Welcome to my Matrix OS profile.</p>

    <div class="apps-section" id="apps">
      <h2>Published Apps</h2>
      <div class="apps-grid" id="apps-grid">
        <p style="color:#71717a;font-size:0.875rem">Loading apps...</p>
      </div>
    </div>

    <p class="powered-by">
      Powered by <a href="https://matrix-os.com">Matrix OS</a>
    </p>
  </div>

  <script>
    const handle = ${JSON.stringify(safeHandle)};
    document.getElementById('avatar').textContent = handle.charAt(0).toUpperCase();
    document.getElementById('display-name').textContent = handle;
    document.getElementById('handle-text').textContent = '@' + handle + ':matrix-os.com';

    (async () => {
      try {
        const res = await fetch('/api/store/apps?author=@' + encodeURIComponent(handle));
        if (!res.ok) return;
        const data = await res.json();
        const grid = document.getElementById('apps-grid');
        grid.textContent = '';
        if (!data.apps || data.apps.length === 0) {
          const p = document.createElement('p');
          p.style.cssText = 'color:#71717a;font-size:0.875rem';
          p.textContent = 'No published apps yet.';
          grid.appendChild(p);
          return;
        }
        for (const app of data.apps) {
          const card = document.createElement('div');
          card.className = 'app-card';
          const nameEl = document.createElement('div');
          nameEl.className = 'name';
          nameEl.textContent = app.name;
          const descEl = document.createElement('div');
          descEl.className = 'desc';
          descEl.textContent = app.description || '';
          card.appendChild(nameEl);
          card.appendChild(descEl);
          grid.appendChild(card);
        }
      } catch (err) {
        void err;
      }
    })();
  </script>
</body>
</html>`;
}
