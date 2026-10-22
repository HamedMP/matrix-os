import React from "react";
import { createRoot } from "react-dom/client";
import catalog from "../../../home/system/app-gallery.json";
import samples from "./fixtures.json";

const requested = new URLSearchParams(location.search).get("app") || "gallery";
const root = createRoot(document.getElementById("root")!);
// This review fixture never connects to a runtime, reads owner data, or writes to disk.
// Gallery installation is deliberately unavailable here; test it on the preview VPS.
if (requested === "gallery") {
  (window as any).MatrixOS = {
    gatewayFetch: async (_url: string, init?: { method?: string }) => {
      if (init?.method === "POST") throw new Error("Install on the preview computer");
      return { version: 1, apps: catalog.apps.map(app => ({ ...app, installed: new URLSearchParams(location.search).get("installed") === "1" && ["folio", "atlas", "subscriptions", "agenda", "focus", "workout-coach"].includes(app.id), launchPath: `apps/${app.id}` })) };
    }, integrations: async () => [],
  };
  await import("../../../home/apps/app-gallery/src/App.css");
  const { default: Gallery } = await import("../../../home/apps/app-gallery/src/App");
  root.render(<Gallery />);
} else {
  const app = catalog.apps.find(app => app.id === requested);
  if (!app) throw new Error("Unknown design preview");
  const fields = samples[requested as keyof typeof samples] ?? [];
  (window as any).MatrixOS = {
    db: { find: async () => fields.map((fields, i) => ({ id: `example-${i}`, payload: {
      id: `example-${i}`, fields, scope: app.collection === "business" ? "work" : "personal",
      accounts: [], sources: [], manualFields: [], updatedAt: "2026-10-08T08:00:00Z",
    } })) }, integrations: async () => [], generate: () => {},
  };
  await import("../../../home/app-templates/connected-starter/src/style.css");
  await import("../../../home/app-templates/connected-starter/src/styles/app-identities.css");
  await import("../../../home/app-templates/connected-starter/src/styles/gallery-light.css");
  const icons = import.meta.glob("../../../home/apps/app-gallery/src/assets/icons/*.png", { eager: true, query: "?url", import: "default" }) as Record<string, string>;
  const iconUrl = Object.entries(icons).find(([name]) => name.endsWith(`/${app.id}.png`))?.[1];
  const iconDataUrl = iconUrl && await new Promise<string>((resolve, reject) => {
    fetch(iconUrl, { signal: AbortSignal.timeout(30_000) }).then(response => response.blob()).then(blob => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    }).catch(reject);
  });
  const { default: App } = await import("../../../home/app-templates/connected-starter/src/App");
  root.render(<App app={{ ...app, iconDataUrl } as any} />);
}
