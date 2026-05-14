import { _electron as electron } from "playwright";
import { resolve } from "node:path";

const repo = resolve(new URL("../..", import.meta.url).pathname);
const shellUrl = process.env.MATRIX_DESKTOP_SHELL_URL ?? "http://localhost:3100";
const gatewayUrl = process.env.MATRIX_DESKTOP_GATEWAY_URL ?? "http://localhost:4000";

function json(body) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  };
}

function routeBody(url) {
  const parsed = new URL(url);
  const path = parsed.pathname;
  if (path.endsWith("/api/settings/onboarding-status")) return { complete: true };
  if (path.startsWith("/api/settings")) {
    return {
      background: { type: "pattern" },
      dock: { position: "left", size: 56, iconSize: 40, autoHide: false },
      pinnedApps: [],
      hasKey: true,
    };
  }
  if (path.endsWith("/api/identity")) return { handle: "smoke", displayName: "Smoke User" };
  if (path.endsWith("/api/conversations")) return [];
  if (path.endsWith("/api/canvases")) return { canvases: [] };
  if (path.endsWith("/api/theme")) {
    return {
      name: "smoke",
      mode: "light",
      style: "flat",
      colors: {
        background: "#fafaf9",
        foreground: "#1c1917",
        card: "#ffffff",
        "card-foreground": "#1c1917",
        popover: "#ffffff",
        "popover-foreground": "#1c1917",
        primary: "#8cc7be",
        "primary-foreground": "#1a1f18",
        secondary: "#f5f5f4",
        "secondary-foreground": "#3c4044",
        muted: "#f5f5f4",
        "muted-foreground": "#6c7178",
        accent: "#f5f5f4",
        "accent-foreground": "#3c4044",
        destructive: "#ef4444",
        border: "#e5e5e4",
        input: "#e5e5e4",
        ring: "#8cc7be",
      },
      fonts: {
        mono: "JetBrains Mono, monospace",
        sans: "Inter, system-ui, sans-serif",
      },
      radius: "0.75rem",
    };
  }
  if (path.endsWith("/api/apps")) {
    return [
      { name: "Symphony", path: "/files/apps/symphony/index.html", icon: "symphony" },
      { name: "Notes", path: "/files/apps/notes/index.html", icon: "notes" },
    ];
  }
  if (path.endsWith("/api/layout")) return { windows: [] };
  if (path.endsWith("/api/desktop/runtime")) {
    return {
      instance: { shellUrl, gatewayUrl, version: "smoke" },
      agentExecution: { mode: "cloud", localAgentsAllowed: false },
      capabilities: ["matrixShell", "appLauncher", "cloudDevelopment", "symphonyRunner"],
    };
  }
  if (path.endsWith("/api/workspace/projects")) {
    return { projects: [{ slug: "repo", name: "Repo", github: { owner: "owner", repo: "repo" } }] };
  }
  if (path.endsWith("/api/tasks")) return [];
  if (path.includes("/api/projects/repo/tickets")) return { tickets: [], nextCursor: null };
  if (path.includes("/api/projects/repo/tasks")) return { tasks: [] };
  if (path.includes("/api/projects/repo/worktrees")) return { worktrees: [] };
  if (path.includes("/api/projects/repo/previews")) return { previews: [] };
  if (path.includes("/api/projects/repo/workflow")) return { workflow: {}, codex: { status: "valid" } };
  if (path.includes("/api/projects/repo/board/members")) return { members: [] };
  if (path.startsWith("/api/reviews")) return { reviews: [] };
  if (path.startsWith("/api/sessions")) return { sessions: [] };
  if (path.startsWith("/api/workspace/events")) return { events: [] };
  if (path.startsWith("/api/files")) return { entries: [], path: "home" };
  if (path.startsWith("/api/symphony")) {
    return {
      installation: null,
      rule: null,
      runs: [],
      events: [],
      codex: { status: "valid" },
      credentialConfigured: false,
    };
  }
  return {};
}

const app = await electron.launch({
  args: [resolve(repo, "apps/desktop/out/main/index.js")],
  env: {
    ...process.env,
    MATRIX_DESKTOP_SHELL_URL: shellUrl,
    MATRIX_DESKTOP_GATEWAY_URL: gatewayUrl,
    ELECTRON_ENABLE_LOGGING: "1",
  },
});

try {
  const context = app.context();
  await context.route("**/ws/**", (route) => route.abort());
  await context.route("**/files/system/icons/**", (route) => route.fulfill({
    status: 200,
    contentType: "image/svg+xml",
    body: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 16 16\"><rect width=\"16\" height=\"16\" rx=\"3\" fill=\"#111827\"/></svg>",
  }));
  await context.route("**/files/system/modules.json", (route) => route.fulfill(json([])));
  await context.route("**/api/**", (route) => route.fulfill(json(routeBody(route.request().url()))));

  const page = await app.firstWindow({ timeout: 20_000 });
  const browserMessages = [];
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) {
      browserMessages.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    browserMessages.push(`pageerror: ${error.message}`);
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  try {
    await page.waitForSelector("[data-testid='dock-settings']", { timeout: 30_000 });
  } catch (err) {
    const diagnostics = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      body: document.body.innerText.slice(0, 2000),
      testIds: Array.from(document.querySelectorAll("[data-testid]"))
        .slice(0, 50)
        .map((node) => node.getAttribute("data-testid")),
      errors: Array.from(document.querySelectorAll("nextjs-portal"))
        .map((node) => node.textContent?.slice(0, 1000)),
    }));
    console.error(JSON.stringify({ desktopSmokeDiagnostics: diagnostics, browserMessages }, null, 2));
    throw err;
  }
  const policy = await page.evaluate(async () => globalThis.window.matrixDesktop?.getRuntimePolicy());
  if (policy?.agentExecution?.mode !== "cloud" || policy?.agentExecution?.localAgentsAllowed !== false) {
    throw new Error(`Unexpected desktop runtime policy: ${JSON.stringify(policy)}`);
  }

  await page.getByTestId("dock-tasks").click();
  await page.getByRole("heading", { name: "Launcher" }).waitFor({ timeout: 15_000 });
  for (const label of ["Workspace", "Files", "Chat", "Symphony", "Notes"]) {
    await page.getByText(label, { exact: true }).first().waitFor({ timeout: 15_000 });
  }

  await page.getByText("Workspace", { exact: true }).first().click();
  await page.getByText("Cloud Workspace", { exact: true }).waitFor({ timeout: 15_000 });

  await page.getByTestId("dock-tasks").click();
  await page.getByText("Files", { exact: true }).first().click();
  await page.getByText("Files", { exact: true }).first().waitFor({ timeout: 15_000 });

  await page.getByTestId("dock-chat").click();
  await page.getByText("Chat").first().waitFor({ timeout: 15_000 });

  await page.getByTestId("dock-settings").click();
  await page.getByText("Settings").first().waitFor({ timeout: 15_000 });

  console.log(JSON.stringify({
    ok: true,
    shellUrl,
    checks: [
      "desktop window loaded Matrix shell",
      "preload runtime policy is cloud-only",
      "launcher opened",
      "launcher listed Workspace, Files, Chat, Symphony, Notes",
      "Workspace opened",
      "Files opened",
      "Chat opened",
      "Settings opened",
    ],
  }, null, 2));
} finally {
  await app.close();
}
