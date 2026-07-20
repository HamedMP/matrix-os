export type BridgeMessage =
  | { type: "os:generate"; app: string; payload: { context: string } }
  | { type: "os:navigate"; app: string; payload: { route: string; context?: string } }
  | { type: "os:read-data"; app: string; payload: { key: string } }
  | { type: "os:write-data"; app: string; payload: { key: string; value: string } }
  | { type: "os:open-app"; app: string; payload: { name: string; path: string } };

export interface BridgeHandler {
  sendToKernel: (text: string) => void;
  fetchData: (
    action: "read" | "write",
    app: string,
    key: string,
    value: string | undefined,
  ) => unknown | Promise<unknown>;
  openApp?: (name: string, path: string) => void;
}

export interface BridgeMessageValidation {
  expectedSource?: MessageEventSource | null;
  expectedOrigins?: ReadonlySet<string>;
  expectedApp?: string;
}

export const THEME_VAR_MAP: Record<string, string> = {
  "--background": "--matrix-bg",
  "--foreground": "--matrix-fg",
  "--card": "--matrix-card",
  "--card-foreground": "--matrix-card-fg",
  "--popover": "--matrix-popover",
  "--popover-foreground": "--matrix-popover-fg",
  "--secondary": "--matrix-secondary",
  "--secondary-foreground": "--matrix-secondary-fg",
  "--muted": "--matrix-muted",
  "--muted-foreground": "--matrix-muted-fg",
  "--primary": "--matrix-primary",
  "--primary-foreground": "--matrix-primary-fg",
  "--forest": "--matrix-brand-primary",
  "--deep": "--matrix-brand-deep",
  "--ember": "--matrix-accent",
  "--ember-foreground": "--matrix-accent-fg",
  "--destructive": "--matrix-destructive",
  "--success": "--matrix-success",
  "--warning": "--matrix-warning",
  "--border": "--matrix-border",
  "--input": "--matrix-input",
  "--ring": "--matrix-ring",
  "--font-sans": "--matrix-font-sans",
  "--font-mono": "--matrix-font-mono",
  "--radius": "--matrix-radius",
};

const THEME_VAR_ALIASES: Record<string, string> = {
  "--matrix-card": "--matrix-card-bg",
  "--matrix-input": "--matrix-input-bg",
};

export type ThemeVars = Record<string, string>;

function replyToDataRequest(event: MessageEvent, request: () => unknown | Promise<unknown>): void {
  const port = event.ports[0];
  if (!port) {
    try {
      void Promise.resolve(request()).catch((err: unknown) => {
        console.warn(
          "[os-bridge] data request failed without a reply port:",
          err instanceof Error ? err.message : String(err),
        );
      });
    } catch (err: unknown) {
      console.warn(
        "[os-bridge] data request failed without a reply port:",
        err instanceof Error ? err.message : String(err),
      );
    }
    return;
  }
  void Promise.resolve()
    .then(request)
    .then((value) => port.postMessage({ ok: true, value }))
    .catch((err: unknown) => {
      console.warn(
        "[os-bridge] data request failed:",
        err instanceof Error ? err.message : String(err),
      );
      port.postMessage({ ok: false });
    })
    .finally(() => port.close());
}

export function getThemeVariables(style: CSSStyleDeclaration): ThemeVars {
  const vars: ThemeVars = {};
  for (const [shellVar, matrixVar] of Object.entries(THEME_VAR_MAP)) {
    vars[matrixVar] = style.getPropertyValue(shellVar).trim();
  }
  for (const [sourceVar, aliasVar] of Object.entries(THEME_VAR_ALIASES)) {
    vars[aliasVar] = vars[sourceVar] ?? "";
  }
  return vars;
}

export function handleBridgeMessage(
  event: MessageEvent,
  handler: BridgeHandler,
  validation: BridgeMessageValidation = {},
) {
  if (validation.expectedSource && event.source !== validation.expectedSource) return;
  if (validation.expectedOrigins && !validation.expectedOrigins.has(event.origin)) return;
  const data = event.data;
  if (!data || typeof data !== "object" || typeof data.type !== "string") return;
  if (!data.type.startsWith("os:")) return;

  const msg = data as BridgeMessage;
  if (validation.expectedApp && msg.app !== validation.expectedApp) return;

  switch (msg.type) {
    case "os:generate":
      handler.sendToKernel(`[App: ${msg.app}] ${msg.payload.context}`);
      break;

    case "os:navigate": {
      const ctx = msg.payload.context
        ? `: ${msg.payload.context}`
        : "";
      handler.sendToKernel(
        `[App: ${msg.app}] Navigate to ${msg.payload.route}${ctx}`,
      );
      break;
    }

    case "os:read-data":
      replyToDataRequest(event, () =>
        handler.fetchData("read", msg.app, msg.payload.key, undefined),
      );
      break;

    case "os:write-data":
      replyToDataRequest(event, () =>
        handler.fetchData("write", msg.app, msg.payload.key, msg.payload.value),
      );
      break;

    case "os:open-app":
      if (handler.openApp && msg.payload.name && msg.payload.path) {
        // Strip /files/ prefix — internal app paths are relative (e.g.
        // "apps/games/2048/index.html"). /api/apps returns absolute
        // "/files/..." URLs, which existing launchers pass through verbatim.
        const normalizedPath = msg.payload.path.replace(/^\/files\//, "");
        handler.openApp(msg.payload.name, normalizedPath);
      }
      break;
  }
}

function buildThemeStyleBlock(themeVars: ThemeVars): string {
  const entries = Object.entries(themeVars)
    .reduce<string[]>((acc, [k, v]) => {
      if (v) acc.push(`    ${k}: ${v};`);
      return acc;
    }, [])
    .join("\n");
  if (!entries) return "";
  return `:root {\n${entries}\n  }`;
}

export function withCredentialedAssets(html: string): string {
  const credentialScript = (tag: string) => {
    if (!/\bsrc\s*=/i.test(tag)) return tag;
    return /\bcrossorigin\b/i.test(tag)
      ? tag.replace(/\bcrossorigin(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/i, 'crossorigin="use-credentials"')
      : tag.replace(/>$/, ' crossorigin="use-credentials">');
  };
  const credentialStylesheet = (tag: string) => {
    if (!/\bhref\s*=/i.test(tag) || !/\brel\s*=\s*(?:"stylesheet"|'stylesheet'|stylesheet)/i.test(tag)) return tag;
    return /\bcrossorigin\b/i.test(tag)
      ? tag.replace(/\bcrossorigin(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/i, 'crossorigin="use-credentials"')
      : tag.replace(/>$/, ' crossorigin="use-credentials">');
  };

  return html
    .replace(/<script\b[^>]*>/gi, credentialScript)
    .replace(/<link\b[^>]*>/gi, credentialStylesheet);
}

const DEFAULT_DESIGN_ID = "flat";
const DESIGN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * Clamp the active shell design id before embedding it in the injected bridge
 * script and theme CSS. Unknown or unsafe ids fall back to the flat design.
 */
function sanitizeDesignId(design: string | undefined): string {
  return design && DESIGN_ID_PATTERN.test(design) ? design : DEFAULT_DESIGN_ID;
}

export function buildBridgeScript(appName: string, themeVars?: ThemeVars, design?: string): string {
  const designId = sanitizeDesignId(design);
  const themeJson = JSON.stringify(themeVars ?? {});
  const initialCss = themeVars
    ? buildThemeStyleBlock({ ...themeVars, "--matrix-design": designId })
    : "";

  return `
(function() {
  var app = ${JSON.stringify(appName)};
  var currentTheme = ${themeJson};
  var currentDesign = ${JSON.stringify(designId)};

  // Tag the document with the active shell design system so app CSS can adapt
  // via :root[data-matrix-design="<id>"] selectors.
  document.documentElement.dataset.matrixDesign = currentDesign;

	  function post(type, payload) {
	    window.parent.postMessage({ type: type, app: app, payload: payload }, "*");
	  }

	  function parentFetch(url, init, timeoutMs) {
	    return new Promise(function(resolve, reject) {
	      var channel = new MessageChannel();
	      var timer = setTimeout(function() {
	        channel.port1.close();
	        reject(new Error("MatrixOS bridge fetch timed out"));
	      }, timeoutMs || 10000);
	      channel.port1.onmessage = function(e) {
	        clearTimeout(timer);
	        channel.port1.close();
	        if (e.data && e.data.ok) {
	          resolve({
	            json: function() { return Promise.resolve(e.data.body); }
	          });
	        } else {
	          reject(new Error("MatrixOS bridge fetch failed"));
	        }
	      };
	      window.parent.postMessage(
	        { type: "os:bridge-fetch", app: app, payload: { url: url, init: init || {} } },
	        "*",
	        [channel.port2]
	      );
	    });
	  }

  // Inject theme style tag
  var themeStyle = document.createElement("style");
  themeStyle.id = "matrix-os-theme";
  themeStyle.textContent = ${JSON.stringify(initialCss)};
  document.head.appendChild(themeStyle);

  var dataChangeCallbacks = [];

  // Listen for dynamic theme updates and data change notifications
  window.addEventListener("message", function(e) {
    if (!e.data || !e.data.type) return;

    if (e.data.type === "os:theme-update" && e.data.payload) {
      currentTheme = e.data.payload;
      if (typeof e.data.design === "string" && /^[a-z0-9][a-z0-9-]{0,31}$/.test(e.data.design)) {
        currentDesign = e.data.design;
      }
      var css = ":root {\\n";
      for (var k in currentTheme) {
        if (currentTheme[k]) css += "    " + k + ": " + currentTheme[k] + ";\\n";
      }
      css += "    --matrix-design: " + currentDesign + ";\\n";
      css += "  }";
      themeStyle.textContent = css;
      document.documentElement.dataset.matrixDesign = currentDesign;
      if (window.MatrixOS) {
        window.MatrixOS.theme = currentTheme;
        window.MatrixOS.design = currentDesign;
      }
    }

    if (e.data.type === "os:data-change" && e.data.payload) {
      var changeKey = e.data.payload.key;
      for (var i = 0; i < dataChangeCallbacks.length; i++) {
        try { dataChangeCallbacks[i](changeKey, e.data.payload.app); } catch(err) {}
      }
    }
  });

  window.MatrixOS = {
    generate: function(context) {
      post("os:generate", { context: context });
    },

    navigate: function(route, context) {
      var payload = { route: route };
      if (context) payload.context = context;
      post("os:navigate", payload);
    },

    readData: function(key) {
      return new Promise(function(resolve, reject) {
        var channel = new MessageChannel();
        channel.port1.onmessage = function(e) {
          channel.port1.close();
          if (e.data && e.data.ok) resolve(e.data.value);
          else reject(new Error("MatrixOS bridge data request failed"));
        };
        window.parent.postMessage(
          { type: "os:read-data", app: app, payload: { key: key } },
          "*",
          [channel.port2]
        );
      });
    },

    writeData: function(key, value) {
      return new Promise(function(resolve, reject) {
        var channel = new MessageChannel();
        channel.port1.onmessage = function(e) {
          channel.port1.close();
          if (e.data && e.data.ok) resolve();
          else reject(new Error("MatrixOS bridge data request failed"));
        };
        window.parent.postMessage(
          {
            type: "os:write-data",
            app: app,
            payload: {
              key: key,
              value: typeof value === "string" ? value : JSON.stringify(value)
            }
          },
          "*",
          [channel.port2]
        );
      });
    },

    openApp: function(name, path) {
      post("os:open-app", { name: name, path: path });
    },

    onDataChange: function(callback) {
      dataChangeCallbacks.push(callback);
      return function() {
        var idx = dataChangeCallbacks.indexOf(callback);
        if (idx >= 0) dataChangeCallbacks.splice(idx, 1);
      };
    },

    theme: currentTheme,

    design: currentDesign,

    app: { name: app },

    integrations: function() {
	      return parentFetch("/api/bridge/service", {}, 10000)
	        .then(function(r) { return r.json(); })
	        .then(function(d) { return d.services || []; });
	    },

    service: function(service, action, params, label) {
	      return parentFetch("/api/bridge/service", {
	        method: "POST",
	        headers: { "Content-Type": "application/json" },
	        body: JSON.stringify({ service: service, action: action, params: params || {}, label: label })
	      }, 35000).then(function(r) { return r.json(); });
	    },

	    gatewayFetch: function(url, init, timeoutMs) {
	      return parentFetch(url, init || {}, timeoutMs || 10000).then(function(r) { return r.json(); });
	    },

	    proxyFetch: function(url) {
	      return parentFetch("/api/bridge/proxy?url=" + encodeURIComponent(url), {}, 12000)
	        .then(function(r) { return r.json(); })
	        .then(function(d) {
	          if (d && d.data !== undefined) return d.data;
	          throw new Error(d && d.error ? d.error : "proxy request failed");
	        });
	    },

	    db: {
	      find: function(table, opts) {
        var body = { app: app, action: "find", table: table };
        if (opts) {
          if (opts.where) body.filter = opts.where;
          if (opts.orderBy) body.orderBy = opts.orderBy;
          if (opts.limit) body.limit = opts.limit;
          if (opts.offset) body.offset = opts.offset;
        }
	        return parentFetch("/api/bridge/query", {
	          method: "POST",
	          headers: { "Content-Type": "application/json" },
	          body: JSON.stringify(body)
	        }, 10000).then(function(r) { return r.json(); });
	      },

	      findOne: function(table, id) {
	        return parentFetch("/api/bridge/query", {
	          method: "POST",
	          headers: { "Content-Type": "application/json" },
	          body: JSON.stringify({ app: app, action: "findOne", table: table, id: id })
	        }, 10000).then(function(r) { return r.json(); });
	      },

	      insert: function(table, data) {
	        return parentFetch("/api/bridge/query", {
	          method: "POST",
	          headers: { "Content-Type": "application/json" },
	          body: JSON.stringify({ app: app, action: "insert", table: table, data: data })
	        }, 10000).then(function(r) { return r.json(); });
	      },

	      update: function(table, id, data) {
	        return parentFetch("/api/bridge/query", {
	          method: "POST",
	          headers: { "Content-Type": "application/json" },
	          body: JSON.stringify({ app: app, action: "update", table: table, id: id, data: data })
	        }, 10000).then(function(r) { return r.json(); });
	      },

	      bulkUpdate: function(table, updates) {
	        return parentFetch("/api/bridge/query", {
	          method: "POST",
	          headers: { "Content-Type": "application/json" },
	          body: JSON.stringify({ app: app, action: "bulkUpdate", table: table, updates: updates })
	        }, 10000).then(function(r) { return r.json(); });
	      },

	      delete: function(table, id) {
	        return parentFetch("/api/bridge/query", {
	          method: "POST",
	          headers: { "Content-Type": "application/json" },
	          body: JSON.stringify({ app: app, action: "delete", table: table, id: id })
	        }, 10000).then(function(r) { return r.json(); });
	      },

	      count: function(table, filter) {
	        return parentFetch("/api/bridge/query", {
	          method: "POST",
	          headers: { "Content-Type": "application/json" },
	          body: JSON.stringify({ app: app, action: "count", table: table, filter: filter })
	        }, 10000).then(function(r) { return r.json(); }).then(function(d) { return d.count; });
	      },

      onChange: function(table, callback) {
        var wrappedCb = function(key, changedApp) {
          if (key === table && changedApp === app) callback({ table: table });
        };
        dataChangeCallbacks.push(wrappedCb);
        return function() {
          var idx = dataChangeCallbacks.indexOf(wrappedCb);
          if (idx >= 0) dataChangeCallbacks.splice(idx, 1);
        };
      }
    }
  };
})();
`;
}
